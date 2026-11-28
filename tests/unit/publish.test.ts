import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseCliArgs } from "../../src/cli/args";
import {
  publishSkillToAwesomeRepo,
  resolvePublishRepoUrl,
  resolvePublishSettings,
} from "../../src/stages/publish/publisher";

function runGit(args: string[], cwd: string): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

function createSampleSkill(dir: string, slug: string, category: string, language: string): void {
  mkdirSync(join(dir, "references/patterns"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${slug}
description: Distilled playbook for ${slug}.
---

# ${slug} Engineering Playbook

| Pattern | Category | Load When (Trigger) | Skip When (Anti-Trigger) | Reference |
| :--- | :--- | :--- | :--- | :--- |
| Sample Pattern | \`${category}\` | Always when testing | Never skip | [\`01-sample.md\`](references/patterns/01-sample.md) |
`,
  );
  writeFileSync(join(dir, "references/patterns/01-sample.md"), "# Sample Pattern\n");
  writeFileSync(
    join(dir, "distill-report.json"),
    JSON.stringify(
      {
        version: "1.0",
        profile: {
          source: `https://github.com/example/${slug}`,
          repoName: slug,
          skillSlug: slug,
          commitSha: "abcdef123456",
          subpath: ".",
          analyzedAt: "2026-11-28T00:00:00.000Z",
          primaryLanguage: language,
          languages: [{ language, fileCount: 10, loc: 500, sharePercent: 100 }],
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
        skillIndexTokens: 120,
      },
      null,
      2,
    ),
  );
}

describe("publish stage and CLI wiring", () => {
  test("parses publish subcommand and --publish/--no-publish flags", () => {
    const pub = parseCliArgs([
      "bun",
      "distill",
      "publish",
      "./.claude/skills/my-skill",
      "--repo",
      "imMamdouhaboammar/awesome-distilled-skills",
      "--set-default",
      "--json",
    ]);
    expect(pub.mode).toBe("publish");
    if (pub.mode === "publish") {
      expect(pub.skillDir).toBe("./.claude/skills/my-skill");
      expect(pub.repo).toBe("imMamdouhaboammar/awesome-distilled-skills");
      expect(pub.setDefault).toBe(true);
      expect(pub.json).toBe(true);
    }

    const defaultPub = parseCliArgs(["bun", "distill", "https://github.com/a/b"]);
    expect(defaultPub.mode).toBe("repo");
    if (defaultPub.mode === "repo") {
      expect(defaultPub.publish).toBe(true);
    }

    const noPubProc = Bun.spawnSync(["bun", "run", "bin/distill-anything.ts", "https://github.com/a/b", "--no-publish"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(noPubProc.exitCode).not.toBe(0);

    const withPub = parseCliArgs([
      "bun",
      "distill",
      "https://github.com/a/b",
      "--publish",
      "--publish-repo",
      "owner/awesome",
    ]);
    expect(withPub.mode).toBe("repo");
    if (withPub.mode === "repo") {
      expect(withPub.publish).toBe(true);
      expect(withPub.publishRepo).toBe("owner/awesome");
    }
  });

  test("resolves owner/repo shorthand and publish settings", () => {
    expect(resolvePublishRepoUrl("imMamdouhaboammar/awesome-distilled-skills")).toBe(
      "https://github.com/imMamdouhaboammar/awesome-distilled-skills.git",
    );

    const cfg = {
      provider: "codex" as const,
      model: "gpt-5.4",
      reasoningEffort: "medium" as const,
      publishRepo: "imMamdouhaboammar/awesome-distilled-skills",
      autoPublish: true,
      updatedAt: "2026-11-28T00:00:00.000Z",
    };

    expect(resolvePublishSettings({ config: cfg }).shouldPublish).toBe(true);
    expect(resolvePublishSettings({ cliPublish: false, config: cfg }).shouldPublish).toBe(false);
    expect(resolvePublishSettings({ config: null })).toEqual({
      shouldPublish: true,
      repo: "imMamdouhaboammar/awesome-distilled-skills",
      branch: "main",
    });
    expect(resolvePublishSettings({ cliPublish: false, config: null }).shouldPublish).toBe(false);
    expect(
      resolvePublishSettings({ config: { ...cfg, autoPublish: false } }).shouldPublish,
    ).toBe(false);
    expect(
      resolvePublishSettings({ cliPublish: true, config: { ...cfg, autoPublish: false } }).shouldPublish,
    ).toBe(true);
  });

  test("publishes skills to bare git repo, rebuilds awesome index with cross-links, and detects up_to_date", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "distill-pub-test-"));
    try {
      const bareRepo = join(sandbox, "awesome.git");
      const seedRepo = join(sandbox, "seed");
      mkdirSync(bareRepo, { recursive: true });
      runGit(["init", "--bare", "--initial-branch=main"], bareRepo);

      runGit(["clone", bareRepo, seedRepo], sandbox);
      runGit(["config", "user.name", "Test"], seedRepo);
      runGit(["config", "user.email", "test@example.com"], seedRepo);

      const awesomeScript = resolve(
        import.meta.dir,
        "../../../awesome-distilled-skills/scripts/build-index.ts",
      );
      if (existsSync(awesomeScript)) {
        mkdirSync(join(seedRepo, "scripts"), { recursive: true });
        cpSync(awesomeScript, join(seedRepo, "scripts/build-index.ts"));
      }
      writeFileSync(join(seedRepo, "README.md"), "# Seed\n");
      runGit(["add", "-A"], seedRepo);
      runGit(["commit", "-m", "init"], seedRepo);
      runGit(["push", "-u", "origin", "main"], seedRepo);

      const skillA = join(sandbox, "skill-a");
      const skillB = join(sandbox, "skill-b");
      createSampleSkill(skillA, "alpha-engine", "concurrency", "rust");
      createSampleSkill(skillB, "beta-queue", "concurrency", "typescript");

      const workDir = join(sandbox, "cache");
      const resA = publishSkillToAwesomeRepo({
        skillDir: skillA,
        repo: bareRepo,
        branch: "main",
        workDir,
      });
      expect(resA.status).toBe("published");
      expect(resA.skillSlug).toBe("alpha-engine");

      const resB = publishSkillToAwesomeRepo({
        skillDir: skillB,
        repo: bareRepo,
        branch: "main",
        workDir,
      });
      expect(resB.status).toBe("published");

      // Re-publishing identical skillB should be up_to_date
      const resBAgain = publishSkillToAwesomeRepo({
        skillDir: skillB,
        repo: bareRepo,
        branch: "main",
        workDir,
      });
      expect(resBAgain.status).toBe("up_to_date");

      if (existsSync(awesomeScript)) {
        const registry = JSON.parse(readFileSync(join(workDir, "registry.json"), "utf8")) as {
          totalSkills: number;
          skills: Array<{ slug: string; relatedSkills: Array<{ slug: string }> }>;
        };
        expect(registry.totalSkills).toBe(2);
        const alpha = registry.skills.find((s) => s.slug === "alpha-engine");
        expect(alpha?.relatedSkills[0]?.slug).toBe("beta-queue");

        const readme = readFileSync(join(workDir, "README.md"), "utf8");
        expect(readme).toContain("Concurrency & Parallelism");
        expect(readme).toContain("alpha-engine");
        expect(readme).toContain("beta-queue");
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
