import { describe, expect, it } from "bun:test";
import { renderSkillIndex } from "../../src/stages/05-compiler/render-skill";
import { renderPatternFile } from "../../src/stages/05-compiler/render-pattern";
import type { RepoProfile } from "../../src/schemas/repo-profile";
import type { VerifiedPattern } from "../../src/schemas/novelty";

const mockProfile: RepoProfile = {
  source: "https://github.com/example/engine",
  repoName: "engine",
  skillSlug: "engine",
  commitSha: "abcdef1234567890",
  subpath: ".",
  analyzedAt: new Date().toISOString(),
  primaryLanguage: "typescript",
  languages: [{ language: "typescript", fileCount: 10, loc: 1200, sharePercent: 100 }],
  totalFilesScanned: 10,
  skippedOversizedFiles: [],
  maturity: {
    classification: "production",
    hasCiWorkflows: true,
    hasBenchmarks: true,
    hasStrictTyping: true,
    testToSourceRatio: 0.5,
    experimentalMarkersPerKloc: 1.0,
  },
};

function makeVerifiedPattern(idx: number, longSnippet = false): VerifiedPattern {
  const snippetLines = Array.from(
    { length: longSnippet ? 80 : 6 },
    (_, i) => `export function step${i}(x: number): number { return x * ${i + 1} + ${idx}; }`,
  ).join("\n");

  return {
    groundingVerified: true,
    blindBaselineSummary: "Baseline uses standard async queue.",
    audit: {
      noveltyScore: 5,
      transferabilityScore: 4,
      antiTriggerQuality: "strict",
      verdict: "keep",
      reasoning: "Distinct lock-free ring buffer mechanism missed by baseline.",
    },
    pattern: {
      id: `pattern-${idx}`,
      title: `High Leverage Engineering Pattern Number ${idx}`,
      category: "concurrency",
      maturityTag: "production_proven",
      evidenceStatus: "seen_explicit",
      problemStatement: "High contention on shared state causes tail-latency spikes under concurrent load.",
      naiveApproach: "Wrapping every operation in a coarse-grained async mutex serializes all callers.",
      repoApproach: "Uses partitioned atomic slots with epoch reclamation to avoid lock contention on hot paths.",
      tradeOffs: ["Increases memory footprint per shard", "More complex debugging when invariants fail"],
      whenToApply: [
        "When profiling shows >20% CPU time spent waiting on a single shared lock across worker threads or async tasks",
      ],
      antiTriggers: [
        "Do not apply when concurrency is low (<100 ops/sec) or simple sequential async/await suffices without contention",
      ],
      citations: [
        {
          filePath: `src/core/mod${idx}.ts`,
          startLine: 10,
          endLine: longSnippet ? 90 : 16,
          verbatimSnippet: snippetLines,
        },
      ],
      transferableRule: `Partition hot state by shard key and reclaim epochs lazily to eliminate global lock contention (${idx}).`,
    },
  };
}

describe("Skill Compiler hard token caps", () => {
  it("enforces SKILL.md <= 1,200 tokens even with 12 verbose patterns", () => {
    const patterns = Array.from({ length: 12 }, (_, i) => makeVerifiedPattern(i + 1));
    const { markdown, tokenCount } = renderSkillIndex({
      profile: mockProfile,
      operatingConstraints: ["Sub-millisecond p99 latency under 10k concurrent streams"],
      patterns,
    });
    expect(tokenCount).toBeLessThanOrEqual(1200);
    expect(markdown).toContain("## Pattern Decision Table");
  });

  it("enforces references/patterns/*.md <= 900 tokens by trimming long snippets", () => {
    const vp = makeVerifiedPattern(1, true);
    const { markdown, tokenCount } = renderPatternFile(vp, "typescript");
    expect(tokenCount).toBeLessThanOrEqual(900);
    expect(markdown).toContain("## Verified Source Evidence");
  });
});
