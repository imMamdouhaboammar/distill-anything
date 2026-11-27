import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger } from "../../src/core/budget";
import { parseCliArgs } from "../../src/cli/args";
import { countTokens } from "../../src/core/tokens";
import {
  applyIncrementalDecisions,
  computeGitDelta,
  runIncrementalUpdate,
} from "../../src/stages/update/incremental";
import type { DistillReport } from "../../src/schemas/report";

function runGit(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

function setupSkillOutput(outDir: string, slug: string, commitSha: string): DistillReport {
  const skillDir = join(outDir, slug);
  const patternsDir = join(skillDir, "references", "patterns");
  mkdirSync(patternsDir, { recursive: true });

  const report: DistillReport = {
    version: "1.0",
    tool: "distill-anything",
    provider: "codex",
    profile: {
      source: "local",
      repoName: slug,
      skillSlug: slug,
      commitSha,
      subpath: ".",
      analyzedAt: new Date().toISOString(),
      primaryLanguage: "typescript",
      languages: [{ language: "typescript", fileCount: 2, loc: 50, sharePercent: 100 }],
      totalFilesScanned: 2,
      skippedOversizedFiles: [],
      maturity: {
        classification: "hybrid",
        hasCiWorkflows: false,
        hasBenchmarks: false,
        hasStrictTyping: true,
        testToSourceRatio: 0.5,
        experimentalMarkersPerKloc: 0,
      },
    },
    outputPath: skillDir,
    groundingMode: "verified_disk",
    minNovelty: 4,
    totalCandidatesExtracted: 2,
    groundingFailures: 0,
    patternsKept: 2,
    patternsDropped: [],
    costs: [],
    totalCostUsd: 0.02,
    skillIndexTokens: 250,
  };

  writeFileSync(join(skillDir, "distill-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${slug}\ndescription: test\n---\n# ${slug}\n`);

  writeFileSync(
    join(patternsDir, "01-experimental-cache.md"),
    `# Experimental Cache

- **Category**: \`memory_performance\`
- **Maturity**: \`experimental_technique\`
- **Evidence**: \`seen_explicit\`
- **Novelty Audit**: \`4/5\` (Transferability: \`4/5\`)

## Problem
Repeated lookups are slow.

## Default Approach (And Why It Breaks)
Recompute every time.

## Repository Pattern
Cache entries in bounded LRU map.

## Verified Source Evidence
**\`src/cache.ts\` (Lines 1–3)** · Commit \`${commitSha}\`
\`\`\`ts
export function getCached(k: string): string | undefined { return undefined; }
\`\`\`

## Trade-Offs
* Uses memory.

## When to Apply
* Hot read paths.

## Anti-Triggers (Do NOT Apply When)
* Write-once paths.
`,
  );

  writeFileSync(
    join(patternsDir, "02-legacy-helper.md"),
    `# Legacy Helper

- **Category**: \`architecture\`
- **Maturity**: \`production_proven\`
- **Evidence**: \`seen_explicit\`
- **Novelty Audit**: \`4/5\` (Transferability: \`4/5\`)

## Problem
Legacy helper needed.

## Default Approach (And Why It Breaks)
Inline logic.

## Repository Pattern
Use legacy helper.

## Verified Source Evidence
**\`src/legacy.ts\` (Lines 1–2)** · Commit \`${commitSha}\`
\`\`\`ts
export function legacyHelper(): number { return 42; }
\`\`\`

## Trade-Offs
* Legacy coupling.

## When to Apply
* Legacy callers.

## Anti-Triggers (Do NOT Apply When)
* New modules.
`,
  );

  return report;
}

describe("Phase 3: Incremental Repository Updates (--update)", () => {
  test("parses --update flag on repo mode", () => {
    const parsed = parseCliArgs([
      "bun",
      "distill-anything",
      "./my-repo",
      "--out",
      "./skills",
      "--name",
      "my-skill",
      "--update",
    ]);
    expect(parsed.mode).toBe("repo");
    if (parsed.mode === "repo") {
      expect(parsed.update).toBe(true);
      expect(parsed.name).toBe("my-skill");
    }
  });

  test("returns up_to_date with zero LLM calls when HEAD === lastCommitSha", async () => {
    const base = mkdtempSync(join(tmpdir(), "distill-inc-noop-"));
    try {
      const repoDir = join(base, "repo");
      const outDir = join(base, "out");
      mkdirSync(join(repoDir, "src"), { recursive: true });
      runGit(["init"], repoDir);
      runGit(["config", "user.email", "test@example.com"], repoDir);
      runGit(["config", "user.name", "Test"], repoDir);
      writeFileSync(join(repoDir, "src/cache.ts"), "export const x = 1;\n");
      runGit(["add", "."], repoDir);
      runGit(["commit", "-m", "init"], repoDir);
      const headSha = runGit(["rev-parse", "HEAD"], repoDir);

      setupSkillOutput(outDir, "my-skill", headSha);
      const budget = new BudgetLedger(1.0);

      const outcome = await runIncrementalUpdate({
        repoRoot: repoDir,
        analysisRoot: repoDir,
        outDir,
        skillSlug: "my-skill",
        headSha,
        modelId: "codex:default",
        judgeModelId: "codex:default",
        budget,
        minNovelty: 4,
        skipNovelty: true,
      });

      expect(outcome.status).toBe("up_to_date");
      expect(budget.getTotalCostUsd()).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("skips LLM calls and updates lastCommitSha on docs-only delta", async () => {
    const base = mkdtempSync(join(tmpdir(), "distill-inc-docs-"));
    try {
      const repoDir = join(base, "repo");
      const outDir = join(base, "out");
      mkdirSync(join(repoDir, "src"), { recursive: true });
      runGit(["init"], repoDir);
      runGit(["config", "user.email", "test@example.com"], repoDir);
      runGit(["config", "user.name", "Test"], repoDir);
      writeFileSync(join(repoDir, "src/cache.ts"), "export const x = 1;\n");
      runGit(["add", "."], repoDir);
      runGit(["commit", "-m", "init"], repoDir);
      const firstSha = runGit(["rev-parse", "HEAD"], repoDir);

      setupSkillOutput(outDir, "my-skill", firstSha);

      // Docs-only commit
      writeFileSync(join(repoDir, "README.md"), "# Updated Docs\n");
      runGit(["add", "README.md"], repoDir);
      runGit(["commit", "-m", "docs: update readme"], repoDir);
      const secondSha = runGit(["rev-parse", "HEAD"], repoDir);

      const delta = computeGitDelta(repoDir, firstSha, secondSha);
      expect(delta.changedSourceFiles.length).toBe(0);

      const budget = new BudgetLedger(1.0);
      const outcome = await runIncrementalUpdate({
        repoRoot: repoDir,
        analysisRoot: repoDir,
        outDir,
        skillSlug: "my-skill",
        headSha: secondSha,
        modelId: "codex:default",
        judgeModelId: "codex:default",
        budget,
        minNovelty: 4,
        skipNovelty: true,
      });

      expect(outcome.status).toBe("docs_only");
      expect(budget.getTotalCostUsd()).toBe(0);
      const updatedReport = JSON.parse(readFileSync(join(outDir, "my-skill/distill-report.json"), "utf8")) as DistillReport;
      expect(updatedReport.profile.commitSha).toBe(secondSha);
      expect(updatedReport.updateHistory?.length).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("promotes experimental_technique to production_proven and deprecates deleted code", async () => {
    const base = mkdtempSync(join(tmpdir(), "distill-inc-apply-"));
    try {
      const repoDir = join(base, "repo");
      const outDir = join(base, "out");
      mkdirSync(join(repoDir, "src"), { recursive: true });
      writeFileSync(
        join(repoDir, "src/cache.ts"),
        `export function getCachedWithGuard(k: string): string | undefined {
  if (!k) throw new Error("empty key");
  return undefined;
}
`,
      );

      const report = setupSkillOutput(outDir, "my-skill", "aaaa1111");
      const budget = new BudgetLedger(1.0);

      const applied = await applyIncrementalDecisions({
        outSkillDir: join(outDir, "my-skill"),
        report,
        fromSha: "aaaa1111",
        toSha: "bbbb2222",
        analysisRoot: repoDir,
        decisions: {
          promotions: [
            {
              patternId: "experimental-cache",
              reason: "Added key validation guard and unit tests.",
              updatedCitation: {
                filePath: "src/cache.ts",
                startLine: 1,
                endLine: 4,
                verbatimSnippet: `export function getCachedWithGuard(k: string): string | undefined {\n  if (!k) throw new Error("empty key");\n  return undefined;\n}`,
              },
            },
          ],
          deprecations: [
            {
              patternId: "legacy-helper",
              reason: "src/legacy.ts was deleted.",
            },
          ],
          additions: [],
        },
        judgeModelId: "codex:default",
        budget,
        minNovelty: 4,
        skipNovelty: true,
      });

      expect(applied.promoted).toBe(1);
      expect(applied.deprecated).toBe(1);
      expect(applied.added).toBe(0);
      expect(applied.report.patternsKept).toBe(1);
      expect(applied.report.updateHistory?.length).toBe(1);
      expect(applied.report.updateHistory?.[0]?.fromSha).toBe("aaaa1111");
      expect(applied.report.updateHistory?.[0]?.toSha).toBe("bbbb2222");

      const promotedMd = readFileSync(join(outDir, "my-skill/references/patterns/01-experimental-cache.md"), "utf8");
      expect(promotedMd).toContain("`production_proven`");
      expect(promotedMd).toContain("getCachedWithGuard");
      expect(existsSync(join(outDir, "my-skill/references/patterns/02-legacy-helper.md"))).toBe(false);

      const skillMd = readFileSync(join(outDir, "my-skill/SKILL.md"), "utf8");
      expect(countTokens(skillMd)).toBeLessThanOrEqual(1200);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
