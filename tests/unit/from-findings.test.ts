import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs } from "../../src/cli/args";
import { BudgetLedger } from "../../src/core/budget";
import { countTokens } from "../../src/core/tokens";
import { EvidenceCitationSchema, type CandidatePattern } from "../../src/schemas/pattern";
import type { VerifiedPattern } from "../../src/schemas/novelty";
import type { RepoProfile } from "../../src/schemas/repo-profile";
import { extractPatternsFromFindings } from "../../src/stages/03-miner/from-findings";
import { groundCandidatePatterns } from "../../src/stages/03-miner/grounder";
import { renderSkillIndex } from "../../src/stages/05-compiler/render-skill";

let fixtureDir: string;
let findingsPath: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "distill-from-findings-"));
  writeFileSync(
    join(fixtureDir, "queue.ts"),
    [
      "export class BoundedQueue<T> {",
      "  private items: T[] = [];",
      "  constructor(private readonly maxSize: number) {}",
      "  enqueue(item: T): boolean {",
      "    if (this.items.length >= this.maxSize) {",
      "      return false;",
      "    }",
      "    this.items.push(item);",
      "    return true;",
      "  }",
      "}",
    ].join("\n"),
  );

  findingsPath = join(fixtureDir, "findings.md");
  writeFileSync(
    findingsPath,
    [
      "# Session Findings",
      "",
      "1. BoundedQueue rejects writes with `false` when `items.length >= maxSize` instead of growing unboundedly.",
      "File: `queue.ts`",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function makePattern(overrides: Partial<CandidatePattern> = {}): CandidatePattern {
  return {
    id: "bounded-queue-backpressure",
    title: "Explicit Backpressure on Bounded Queue",
    category: "concurrency",
    maturityTag: "production_proven",
    evidenceStatus: "seen_explicit",
    problemStatement: "Unbounded in-memory queues cause OOM crashes under slow consumers.",
    naiveApproach: "Push items into an unbounded array and hope consumers catch up.",
    repoApproach: "Checks length against maxSize on enqueue and returns false to signal backpressure.",
    tradeOffs: ["Callers must handle rejected writes", "Fixed memory footprint"],
    whenToApply: ["Producer/consumer pipelines with bursty traffic"],
    antiTriggers: ["When every event must be buffered regardless of memory", "Single-item state"],
    citations: [
      {
        filePath: "queue.ts",
        startLine: 4,
        endLine: 10,
        verbatimSnippet: [
          "  enqueue(item: T): boolean {",
          "    if (this.items.length >= this.maxSize) {",
          "      return false;",
          "    }",
          "    this.items.push(item);",
          "    return true;",
          "  }",
        ].join("\n"),
      },
    ],
    transferableRule: "Return a boolean backpressure signal from enqueue when capacity is reached.",
    ...overrides,
  };
}

describe("distill from-findings", () => {
  it("parses both legacy `distill <source>` and `distill from-findings <file>`", () => {
    const repoOpts = parseCliArgs(["bun", "distill", "/tmp/my-repo", "--out", "/tmp/out", "--dry-run"]);
    expect(repoOpts.mode).toBe("repo");
    if (repoOpts.mode === "repo") {
      expect(repoOpts.source).toBe("/tmp/my-repo");
      expect(repoOpts.out).toBe("/tmp/out");
      expect(repoOpts.dryRun).toBe(true);
    }

    const findingsOpts = parseCliArgs([
      "bun",
      "distill",
      "from-findings",
      findingsPath,
      "--repo",
      fixtureDir,
      "--out",
      "/tmp/skills",
      "--name",
      "my-skill",
    ]);
    expect(findingsOpts.mode).toBe("from-findings");
    if (findingsOpts.mode === "from-findings") {
      expect(findingsOpts.findingsFile).toBe(findingsPath);
      expect(findingsOpts.repo).toBe(fixtureDir);
      expect(findingsOpts.allowUngrounded).toBe(false);
      expect(findingsOpts.name).toBe("my-skill");
    }
  });

  it("exits with code 2 when --repo is missing without --allow-ungrounded", () => {
    expect(() =>
      parseCliArgs(["bun", "distill", "from-findings", findingsPath]),
    ).toThrow();

    const proc = Bun.spawnSync(
      ["bun", "run", resolve("bin/distill-anything.ts"), "from-findings", findingsPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("--repo");
  });

  it("stamps ungrounded_notes into SKILL.md and skips grounder when --allow-ungrounded is set", async () => {
    const ungroundedPattern = makePattern({
      citations: [
        {
          filePath: "nonexistent/virtual.ts",
          startLine: 1,
          endLine: 3,
          verbatimSnippet: "export function virtualOnlySnippet() { return true; }",
        },
      ],
    });

    const mined = await extractPatternsFromFindings({
      findingsFile: findingsPath,
      repoName: "virtual-notes",
      primaryLanguage: "typescript",
      allowUngrounded: true,
      modelId: "anthropic:claude-sonnet-4-5",
      budget: new BudgetLedger(2.0),
      llmCall: (async () => ({
        object: {
          repoDomainSummary: "Bounded queue architecture from session notes.",
          operatingConstraints: ["Strict memory cap"],
          patterns: [ungroundedPattern],
        },
        cost: {
          stage: "miner",
          model: "anthropic:claude-sonnet-4-5",
          inputTokens: 100,
          outputTokens: 100,
          costUsd: 0.001,
          durationMs: 10,
        },
      })) as typeof import("../../src/core/llm").callStructuredLlm,
    });

    expect(mined.groundingFailures).toBe(0);
    expect(mined.groundedPatterns).toHaveLength(1);

    const profile: RepoProfile = {
      source: "ungrounded_notes",
      repoName: "virtual-notes",
      skillSlug: "virtual-notes",
      commitSha: null,
      subpath: ".",
      analyzedAt: new Date().toISOString(),
      primaryLanguage: "typescript",
      languages: [{ language: "typescript", fileCount: 0, loc: 0, sharePercent: 100 }],
      totalFilesScanned: 0,
      skippedOversizedFiles: [],
      maturity: {
        classification: "hybrid",
        hasCiWorkflows: false,
        hasBenchmarks: false,
        hasStrictTyping: false,
        testToSourceRatio: 0,
        experimentalMarkersPerKloc: 0,
      },
    };

    const verified: VerifiedPattern[] = [
      {
        pattern: mined.groundedPatterns[0]!,
        groundingVerified: false,
        blindBaselineSummary: "Baseline",
        audit: {
          noveltyScore: 4,
          transferabilityScore: 4,
          antiTriggerQuality: "strict",
          verdict: "keep",
          reasoning: "Concrete backpressure pattern.",
        },
      },
    ];

    const { markdown } = renderSkillIndex({
      profile,
      operatingConstraints: mined.operatingConstraints,
      patterns: verified,
      groundingMode: "ungrounded_notes",
    });

    expect(markdown).toContain("ungrounded_notes");
  });

  it("matches a finding snippet in grounder.ts when line numbers are omitted or drifted", () => {
    const omittedCitation = EvidenceCitationSchema.parse({
      filePath: "queue.ts",
      verbatimSnippet: [
        "  enqueue(item: T): boolean {",
        "    if (this.items.length >= this.maxSize) {",
        "      return false;",
        "    }",
        "    this.items.push(item);",
        "    return true;",
        "  }",
      ].join("\n"),
    });

    const pattern = makePattern({ citations: [omittedCitation] });
    const res = groundCandidatePatterns([pattern], fixtureDir);
    expect(res.groundingFailures).toBe(0);
    expect(res.groundedPatterns).toHaveLength(1);
    expect(res.groundedPatterns[0]?.citations[0]?.startLine).toBe(4);
    expect(res.groundedPatterns[0]?.citations[0]?.endLine).toBe(10);
  });

  it("keeps skills/distill-anything/SKILL.md concise (<= 600 tokens)", () => {
    const skillContent = readFileSync(resolve("skills/distill-anything/SKILL.md"), "utf8");
    expect(countTokens(skillContent)).toBeLessThanOrEqual(600);
  });
});
