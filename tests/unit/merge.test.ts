import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../../src/cli/args";
import { countTokens } from "../../src/core/tokens";
import {
  compileMergedPlaybook,
  discoverSkillDirs,
  loadDistilledSkills,
  MergeInputError,
} from "../../src/stages/06-merge/synthesize";
import type { MergeSynthesisOutput } from "../../src/schemas/merge";
import type { DistillReport } from "../../src/schemas/report";

function createFixtureSkill(
  parentDir: string,
  slug: string,
  repoName: string,
  commitSha: string,
  patterns: Array<{ id: string; title: string; category: string; snippet: string; filePath: string }>,
): string {
  const skillDir = join(parentDir, slug);
  const patternsDir = join(skillDir, "references", "patterns");
  mkdirSync(patternsDir, { recursive: true });

  const report: DistillReport = {
    version: "1.0",
    tool: "distill-anything",
    provider: "codex",
    profile: {
      source: `https://github.com/org/${repoName}`,
      repoName,
      skillSlug: slug,
      commitSha,
      subpath: ".",
      analyzedAt: new Date().toISOString(),
      primaryLanguage: "rust",
      languages: [{ language: "rust", fileCount: 10, loc: 1200, sharePercent: 100 }],
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
    },
    outputPath: skillDir,
    groundingMode: "verified_disk",
    minNovelty: 4,
    totalCandidatesExtracted: patterns.length,
    groundingFailures: 0,
    patternsKept: patterns.length,
    patternsDropped: [],
    costs: [],
    totalCostUsd: 0.05,
    skillIndexTokens: 400,
  };

  writeFileSync(join(skillDir, "distill-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: Test skill\n---\n\n# ${repoName}\n\n## Quick Transferable Rules\n${patterns
      .map((p) => `- **${p.title}**: Always apply ${p.id} for deterministic performance.`)
      .join("\n")}\n`,
  );

  patterns.forEach((p, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const md = `# ${p.title}

- **Category**: \`${p.category}\`
- **Maturity**: \`production_proven\`
- **Evidence**: \`seen_explicit\`
- **Novelty Audit**: \`4/5\` (Transferability: \`4/5\`)

## Problem
Contention or allocation overhead in ${repoName}.

## Default Approach (And Why It Breaks)
Standard mutex or heap allocation per request.

## Repository Pattern
Use ${p.id} to eliminate contention.

## Verified Source Evidence
**\`${p.filePath}\` (Lines 10–18)** · Commit \`${commitSha}\`
\`\`\`rust
${p.snippet}
\`\`\`

## Trade-Offs
* Increases code complexity slightly.

## When to Apply
* High-throughput hot paths in ${repoName}.

## Anti-Triggers (Do NOT Apply When)
* Cold initialization paths.
`;
    writeFileSync(join(patternsDir, `${num}-${p.id}.md`), md);
  });

  return skillDir;
}

describe("Phase 2: Cross-Repo Skill Synthesis (distill-anything merge)", () => {
  test("parses merge CLI arguments and enforces required --name", () => {
    const parsed = parseCliArgs([
      "bun",
      "distill-anything",
      "merge",
      "./skills-parent",
      "--name",
      "nvidia-systems",
      "--max-patterns",
      "8",
      "--json",
    ]);

    expect(parsed.mode).toBe("merge");
    if (parsed.mode === "merge") {
      expect(parsed.skillDirs).toEqual(["./skills-parent"]);
      expect(parsed.name).toBe("nvidia-systems");
      expect(parsed.maxPatterns).toBe(8);
      expect(parsed.json).toBe(true);
    }
  });

  test("auto-discovers multiple skills from a single parent directory and fails cleanly on < 2 skills", () => {
    const parent = mkdtempSync(join(tmpdir(), "distill-merge-disc-"));
    try {
      const s1 = createFixtureSkill(parent, "skill-a", "repo-a", "aaaa1111", [
        {
          id: "ring-buffer",
          title: "Lock-Free Ring Buffer",
          category: "concurrency",
          filePath: "src/ring.rs",
          snippet: "pub fn push_atomic(&self, v: u64) -> bool { true }",
        },
      ]);

      expect(() => discoverSkillDirs([s1])).toThrow(MergeInputError);

      createFixtureSkill(parent, "skill-b", "repo-b", "bbbb2222", [
        {
          id: "sharded-map",
          title: "Sharded Concurrent Map",
          category: "concurrency",
          filePath: "src/shard.rs",
          snippet: "pub fn shard_idx(key: u64) -> usize { (key as usize) & 63 }",
        },
      ]);

      const discovered = discoverSkillDirs([parent]);
      expect(discovered.length).toBe(2);

      const loaded = loadDistilledSkills([parent]);
      expect(loaded.length).toBe(2);
      expect(loaded[0]?.patterns[0]?.sourceCommitSha).toBeTruthy();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("re-attaches verbatim snippets without mutation, preserves conflict branches, enforces --max-patterns and token caps", () => {
    const parent = mkdtempSync(join(tmpdir(), "distill-merge-compile-"));
    try {
      const exactSnippetA = "pub fn push_atomic(&self, v: u64) -> bool {\n    self.head.fetch_add(1, Ordering::AcqRel) < CAP\n}";
      const exactSnippetB = "pub fn shard_lock(&self, k: u64) -> MutexGuard<'_, Entry> {\n    self.shards[(k as usize) & 63].lock()\n}";

      const patternsA = Array.from({ length: 8 }, (_, i) => ({
        id: i === 0 ? "ring-buffer" : `pattern-a-${i}`,
        title: i === 0 ? "Lock-Free Ring Buffer" : `Pattern A ${i} With Descriptive Title`,
        category: i % 2 === 0 ? "concurrency" : "memory_performance",
        filePath: `src/a_${i}.rs`,
        snippet: i === 0 ? exactSnippetA : `pub fn a_${i}() -> usize { ${i} }`,
      }));

      const patternsB = Array.from({ length: 8 }, (_, i) => ({
        id: i === 0 ? "sharded-map" : `pattern-b-${i}`,
        title: i === 0 ? "Sharded Concurrent Map" : `Pattern B ${i} With Descriptive Title`,
        category: i % 2 === 0 ? "concurrency" : "architecture",
        filePath: `src/b_${i}.rs`,
        snippet: i === 0 ? exactSnippetB : `pub fn b_${i}() -> usize { ${i} }`,
      }));

      createFixtureSkill(parent, "skill-a", "repo-a", "aaaa1111", patternsA);
      createFixtureSkill(parent, "skill-b", "repo-b", "bbbb2222", patternsB);
      const loadedSkills = loadDistilledSkills([parent]);

      const synthesis: MergeSynthesisOutput = {
        operatingConstraints: ["High-throughput low-latency systems", "Zero-allocation hot paths"],
        mergedPatterns: [
          {
            id: "bounded-concurrent-queue",
            title: "Bounded Concurrent Queue vs Sharded Map",
            category: "concurrency",
            maturityTag: "production_proven",
            noveltyScore: 5,
            transferabilityScore: 5,
            consensusCount: 2,
            problemStatement: "High-contention shared state stalls worker threads.",
            naiveApproach: "Single global Mutex<VecDeque<T>>.",
            repoApproach: "Choose between SPSC/MPSC lock-free ring buffer or 64-way sharded mutexes.",
            transferableRule: "Use lock-free ring buffers for FIFO streams and sharded locks for random-key lookups.",
            tradeOffs: ["Ring buffers have fixed capacity; sharded maps require power-of-two shards."],
            whenToApply: ["Multi-core worker pipelines with >8 threads."],
            antiTriggers: ["Single-threaded event loops."],
            snippetRefs: [
              { sourceSkillId: "skill-a", patternId: "ring-buffer", citationIndex: 0 },
              { sourceSkillId: "skill-b", patternId: "sharded-map", citationIndex: 0 },
            ],
            conflictBranches: [
              {
                sourceRepo: "repo-a",
                whenThisWins: "Strict FIFO streaming with bounded queue depth",
                approach: "Use atomic head/tail ring buffer without locks.",
                snippetRef: { sourceSkillId: "skill-a", patternId: "ring-buffer", citationIndex: 0 },
              },
              {
                sourceRepo: "repo-b",
                whenThisWins: "Arbitrary key-value lookups with mixed read/write",
                approach: "Partition state across 64 cache-line-aligned mutex shards.",
                snippetRef: { sourceSkillId: "skill-b", patternId: "sharded-map", citationIndex: 0 },
              },
            ],
          },
          ...Array.from({ length: 13 }, (_, i) => ({
            id: `extra-pattern-${i + 1}`,
            title: `Extra System Pattern ${i + 1} With Long Explanatory Name`,
            category: (i % 2 === 0 ? "memory_performance" : "architecture") as "memory_performance" | "architecture",
            maturityTag: "production_proven" as const,
            noveltyScore: 4,
            transferabilityScore: 4,
            consensusCount: 1,
            problemStatement: "Repeated overhead in hot path.",
            naiveApproach: "Default allocation.",
            repoApproach: "Preallocate arena.",
            transferableRule: `Always preallocate arena buffer #${i + 1} before entering the hot loop.`,
            tradeOffs: ["Uses upfront memory."],
            whenToApply: [`When processing large batch workloads in module ${i + 1} under strict latency SLAs.`],
            antiTriggers: [`Small one-off CLI scripts with < 100 items in module ${i + 1}.`],
            snippetRefs: [
              {
                sourceSkillId: i < 7 ? "skill-a" : "skill-b",
                patternId: i < 7 ? `pattern-a-${i + 1}` : `pattern-b-${i - 6}`,
                citationIndex: 0,
              },
            ],
          })),
        ],
      };

      const compiled = compileMergedPlaybook({
        loadedSkills,
        synthesis,
        outputSlug: "unified-systems",
        maxPatterns: 10,
      });

      // Enforces --max-patterns 10 (out of 14 synthesized)
      expect(compiled.compiledPatterns.length).toBe(10);
      expect(compiled.droppedPatterns.length).toBe(4);
      expect(compiled.droppedPatterns[0]?.stage).toBe("merge_overflow");

      // Enforces SKILL.md <= 1,200 tokens and pattern files <= 900 tokens
      expect(compiled.skillIndexTokens).toBeLessThanOrEqual(1200);
      expect(countTokens(compiled.skillMd)).toBeLessThanOrEqual(1200);
      expect(compiled.skillMd).toContain("Synthesized From (2 repos)");
      for (const p of compiled.compiledPatterns) {
        expect(p.tokenCount).toBeLessThanOrEqual(900);
      }

      // Verifies verbatim snippet re-attachment (zero mutation) and conflict branches
      const firstPatternMd = compiled.compiledPatterns[0]!.markdown;
      expect(firstPatternMd).toContain(exactSnippetA);
      expect(firstPatternMd).toContain(exactSnippetB);
      expect(firstPatternMd).toContain("## Conflicting Approaches (Conditional Decision Branches)");
      expect(firstPatternMd).toContain("When `repo-a` Wins");
      expect(firstPatternMd).toContain("When `repo-b` Wins");
      expect(firstPatternMd).toContain("repo-a@aaaa1111:src/a_0.rs");
      expect(firstPatternMd).toContain("repo-b@bbbb2222:src/b_0.rs");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
