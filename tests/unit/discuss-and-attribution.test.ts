import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../../src/cli/args";
import {
  collectOwnerMentions,
  extractGitHubRepo,
  formatGitHubOwnerMention,
  formatSourceAttribution,
} from "../../src/core/attribution";
import { renderSkillIndex } from "../../src/stages/05-compiler/render-skill";
import { buildDiscussionContent, openSkillDiscussion } from "../../src/stages/publish/discuss";
import { DEFAULT_AWESOME_REPO, resolvePublishSettings } from "../../src/stages/publish/publisher";
import type { VerifiedPattern } from "../../src/schemas/novelty";
import type { RepoProfile } from "../../src/schemas/repo-profile";

function createSampleSkillDir(dir: string, source: string, slug = "sample-engine"): void {
  mkdirSync(join(dir, "references/patterns"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${slug}
description: Distilled playbook for ${slug}.
---

# ${slug} Engineering Playbook

- **Source**: [\`example/${slug}\`](${source}) @ \`abcdef12\` (by [@example](https://github.com/example))

| Pattern | Category | Load When (Trigger) | Skip When (Anti-Trigger) | Reference |
| :--- | :--- | :--- | :--- | :--- |
| Bounded Queue | \`concurrency\` | When applying backpressure | Never for unbounded logs | [\`01-bounded-queue.md\`](references/patterns/01-bounded-queue.md) |
`,
  );
  writeFileSync(join(dir, "references/patterns/01-bounded-queue.md"), "# Bounded Queue\n");
  writeFileSync(
    join(dir, "distill-report.json"),
    JSON.stringify(
      {
        version: "1.0",
        profile: {
          source,
          repoName: slug,
          skillSlug: slug,
          commitSha: "abcdef123456",
          subpath: ".",
          analyzedAt: "2026-11-28T00:00:00.000Z",
          primaryLanguage: "rust",
          languages: [{ language: "rust", fileCount: 10, loc: 500, sharePercent: 100 }],
          totalFilesScanned: 10,
          skippedOversizedFiles: [],
          maturity: {
            classification: "production",
            hasCiWorkflows: true,
            hasBenchmarks: false,
            hasStrictTyping: true,
            testToSourceRatio: 0.5,
            experimentalMarkersPerKloc: 0,
          },
        },
        outputPath: dir,
        groundingMode: "verified_disk",
        totalCandidatesExtracted: 1,
        groundingFailures: 0,
        patternsKept: 1,
        patternsDropped: [],
        costs: [],
        totalCostUsd: 0,
        skillIndexTokens: 140,
      },
      null,
      2,
    ),
  );
}

describe("attribution, owner mentions, and GitHub Discussions", () => {
  test("extracts GitHub owner/repo from HTTPS and SSH URLs and formats mentions", () => {
    expect(extractGitHubRepo("https://github.com/tokio-rs/tokio.git")).toEqual({
      owner: "tokio-rs",
      repo: "tokio",
      slug: "tokio-rs/tokio",
      url: "https://github.com/tokio-rs/tokio",
    });
    expect(extractGitHubRepo("git@github.com:oven-sh/bun.git")).toEqual({
      owner: "oven-sh",
      repo: "bun",
      slug: "oven-sh/bun",
      url: "https://github.com/oven-sh/bun",
    });
    expect(extractGitHubRepo("/Users/dev/local-repo")).toBeNull();
    expect(formatGitHubOwnerMention("https://github.com/vercel/next.js")).toBe("@vercel");
    expect(formatSourceAttribution("https://github.com/vercel/next.js", "1234567890")).toContain(
      "[@vercel](https://github.com/vercel)",
    );
    expect(
      collectOwnerMentions([
        "https://github.com/vercel/next.js",
        "git@github.com:Vercel/turbo.git",
        "/tmp/local",
      ]),
    ).toEqual(["@vercel"]);
  });

  test("renderSkillIndex embeds @owner attribution while staying <= 1,200 tokens", () => {
    const profile: RepoProfile = {
      source: "https://github.com/tokio-rs/tokio",
      repoName: "tokio",
      skillSlug: "tokio",
      commitSha: "deadbeef1234",
      subpath: ".",
      analyzedAt: "2026-11-28T00:00:00.000Z",
      primaryLanguage: "rust",
      languages: [{ language: "rust", fileCount: 10, loc: 500, sharePercent: 100 }],
      totalFilesScanned: 10,
      skippedOversizedFiles: [],
      maturity: {
        classification: "production",
        hasCiWorkflows: true,
        hasBenchmarks: true,
        hasStrictTyping: true,
        testToSourceRatio: 0.4,
        experimentalMarkersPerKloc: 0,
      },
    };
    const patterns: VerifiedPattern[] = [
      {
        pattern: {
          id: "coop-budget",
          title: "Cooperative Task Budgeting",
          category: "concurrency",
          maturityTag: "production_proven",
          evidenceStatus: "seen_explicit",
          problemStatement: "Unbounded poll loops starve sibling tasks on the same executor thread.",
          naiveApproach: "Poll the inner future in an unbounded loop until Pending is returned.",
          repoApproach: "Consume a per-poll cooperative budget before returning Pending and waking.",
          tradeOffs: ["Adds atomic counter decrement per poll", "Prevents single-task starvation"],
          whenToApply: ["Implementing custom async streams or multiplexers"],
          antiTriggers: ["Simple single-shot futures", "Blocking thread-per-request handlers"],
          transferableRule: "Bound consecutive polls per task turn with explicit cooperative yield.",
          citations: [
            {
              filePath: "src/task.rs",
              startLine: 1,
              endLine: 3,
              verbatimSnippet: "pub fn poll_budget(&mut self) -> bool { self.remaining > 0 }",
            },
          ],
        },
        groundingVerified: true,
        blindBaselineSummary: "Baseline suggested standard futures without budgeting.",
        audit: {
          noveltyScore: 5,
          transferabilityScore: 5,
          antiTriggerQuality: "strict",
          verdict: "keep",
          reasoning: "Non-obvious cooperative runtime fairness invariant.",
        },
      },
    ];

    const { markdown, tokenCount } = renderSkillIndex({
      profile,
      operatingConstraints: ["High-throughput async runtime"],
      patterns,
    });
    expect(markdown).toContain("[@tokio-rs](https://github.com/tokio-rs)");
    expect(tokenCount).toBeLessThanOrEqual(1200);
  });

  test("parses discuss subcommand and --discuss flags on repo/publish/merge", () => {
    const discussCmd = parseCliArgs([
      "bun",
      "distill",
      "discuss",
      "./.claude/skills/tokio",
      "--target",
      "source",
      "--category",
      "Show and tell",
      "--dry-run",
      "--json",
    ]);
    expect(discussCmd.mode).toBe("discuss");
    if (discussCmd.mode === "discuss") {
      expect(discussCmd.skillDir).toBe("./.claude/skills/tokio");
      expect(discussCmd.target).toBe("source");
      expect(discussCmd.category).toBe("Show and tell");
      expect(discussCmd.dryRun).toBe(true);
      expect(discussCmd.json).toBe(true);
    }

    const repoCmd = parseCliArgs([
      "bun",
      "distill",
      "https://github.com/tokio-rs/tokio",
      "--publish",
      "--discuss",
      "--discuss-target",
      "awesome",
    ]);
    expect(repoCmd.mode).toBe("repo");
    if (repoCmd.mode === "repo") {
      expect(repoCmd.publish).toBe(true);
      expect(repoCmd.discuss).toBe(true);
      expect(repoCmd.discussTarget).toBe("awesome");
    }

    expect(resolvePublishSettings({ cliPublish: true, config: null }).repo).toBe(DEFAULT_AWESOME_REPO);
  });

  test("openSkillDiscussion builds @owner mention, supports dry-run, browser open, and GraphQL fallback", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "distill-discuss-test-"));
    try {
      const skillDir = join(sandbox, "tokio");
      createSampleSkillDir(skillDir, "https://github.com/tokio-rs/tokio", "tokio");

      const built = buildDiscussionContent({ skillDir });
      expect(built.mentionedOwners).toContain("@tokio-rs");
      expect(built.body).toContain("@tokio-rs");
      expect(built.body).toContain("awesome-distilled-skills/tree/main/skills/tokio");

      const dry = openSkillDiscussion({ skillDir, dryRun: true });
      expect(dry.status).toBe("dry_run");
      expect(dry.targetRepo).toBe("tokio-rs/tokio");
      expect(dry.url).toContain("https://github.com/tokio-rs/tokio/discussions/new?");

      let openedUrl = "";
      const browser = openSkillDiscussion({
        skillDir,
        openBrowser: true,
        browserOpener: (url) => {
          openedUrl = url;
        },
      });
      expect(browser.status).toBe("browser_opened");
      expect(openedUrl).toBe(browser.url);

      // GraphQL auto-fallback: source has discussions disabled -> falls back to awesome repo
      const queries: Array<{ query: string; variables: Record<string, string> }> = [];
      const created = openSkillDiscussion({
        skillDir,
        target: "auto",
        graphqlRunner: (query, variables) => {
          queries.push({ query, variables });
          if (query.includes("query(")) {
            if (variables.owner === "tokio-rs") {
              return {
                data: {
                  repository: {
                    id: "R_source",
                    hasDiscussionsEnabled: false,
                    discussionCategories: { nodes: [] },
                  },
                },
              };
            }
            return {
              data: {
                repository: {
                  id: "R_awesome",
                  hasDiscussionsEnabled: true,
                  discussionCategories: {
                    nodes: [{ id: "DIC_1", name: "Show and tell", slug: "show-and-tell" }],
                  },
                },
              },
            };
          }
          return {
            data: {
              createDiscussion: {
                discussion: {
                  number: 42,
                  url: "https://github.com/imMamdouhaboammar/awesome-distilled-skills/discussions/42",
                },
              },
            },
          };
        },
      });
      expect(created.status).toBe("created");
      expect(created.targetRepo).toBe(DEFAULT_AWESOME_REPO);
      expect(created.discussionNumber).toBe(42);
      expect(created.category).toBe("Show and tell");
      expect(queries.length).toBe(3);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
