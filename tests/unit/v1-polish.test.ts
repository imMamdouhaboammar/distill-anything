import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../../src/cli/args";
import { mineHighSignalCommits } from "../../src/stages/02-signals/git-miner";
import { passesNoveltyThreshold } from "../../src/stages/04-novelty/judge";
import { renderPatternFile } from "../../src/stages/05-compiler/render-pattern";
import type { VerifiedPattern } from "../../src/schemas/novelty";

function runGit(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
}

function makeVerifiedPattern(noveltyScore: number): VerifiedPattern {
  return {
    pattern: {
      id: "bounded-worker-pool",
      title: "Bounded Worker Pool",
      category: "concurrency",
      maturityTag: "production_proven",
      evidenceStatus: "seen_explicit",
      problemStatement: "Unbounded Promise.all spikes memory and sockets under load.",
      naiveApproach: "Dispatch all promises concurrently with Promise.all.",
      repoApproach: "Use a fixed-size worker queue pulling from a shared index.",
      citations: [
        {
          filePath: "src/pool.ts",
          startLine: 1,
          endLine: 3,
          verbatimSnippet: "export async function runPool() {\n  return true;\n}",
        },
      ],
      tradeOffs: ["Slightly higher latency for single-item bursts"],
      whenToApply: ["Fan-out exceeds 10 concurrent I/O operations"],
      antiTriggers: ["Fewer than 4 independent tasks"],
      transferableRule: "Bound concurrent async work with a fixed worker pool.",
    },
    groundingVerified: true,
    blindBaselineSummary: "Standard baseline uses Promise.all.",
    audit: {
      noveltyScore,
      transferabilityScore: 4,
      antiTriggerQuality: "adequate",
      verdict: noveltyScore >= 4 ? "keep" : "drop",
      reasoning: "Test audit reasoning.",
    },
  };
}

describe("v1.0 polish sprint", () => {
  describe("1. git-miner.ts smart fallback", () => {
    it("activates when keyword matches are 0, selects Bucket A commits (15-350 lines), and excludes noise commits", () => {
      const repoDir = mkdtempSync(join(tmpdir(), "distill-git-fallback-"));
      try {
        runGit(["init", "-q"], repoDir);
        runGit(["config", "user.email", "dev@example.com"], repoDir);
        runGit(["config", "user.name", "Dev"], repoDir);

        mkdirSync(join(repoDir, "src"), { recursive: true });
        writeFileSync(join(repoDir, "src/core.ts"), "export const v = 0;\n");
        writeFileSync(join(repoDir, "src/other.ts"), "export const o = 0;\n");
        runGit(["add", "."], repoDir);
        runGit(["commit", "-q", "-m", "initial setup"], repoDir);

        // 1. Valid fallback commit: touches Bucket A file, 25 lines, has >40 char body, no formal keywords
        const lines25 = Array.from({ length: 25 }, (_, i) => `export const a${i} = ${i};`).join("\n") + "\n";
        writeFileSync(join(repoDir, "src/core.ts"), lines25);
        runGit(["add", "src/core.ts"], repoDir);
        runGit(
          [
            "commit",
            "-q",
            "-m",
            "update core handler",
            "-m",
            "Fixes an edge behavior in the main handler when input array is empty during startup.",
          ],
          repoDir,
        );

        // 2. Excluded: release/format/bump/lint commits touching Bucket A
        const lines20 = Array.from({ length: 20 }, (_, i) => `export const b${i} = ${i};`).join("\n") + "\n";
        writeFileSync(join(repoDir, "src/core.ts"), lines20);
        runGit(["add", "src/core.ts"], repoDir);
        runGit(["commit", "-q", "-m", "format code with prettier"], repoDir);

        const lines22 = Array.from({ length: 22 }, (_, i) => `export const c${i} = ${i};`).join("\n") + "\n";
        writeFileSync(join(repoDir, "src/core.ts"), lines22);
        runGit(["add", "src/core.ts"], repoDir);
        runGit(["commit", "-q", "-m", "bump dependencies"], repoDir);

        // 3. Excluded: touches only non-Bucket-A file
        writeFileSync(join(repoDir, "src/other.ts"), lines25);
        runGit(["add", "src/other.ts"], repoDir);
        runGit(["commit", "-q", "-m", "update helper module"], repoDir);

        // 4. Excluded: too small (< 15 lines)
        writeFileSync(join(repoDir, "src/core.ts"), lines22 + "export const tiny = 1;\n");
        runGit(["add", "src/core.ts"], repoDir);
        runGit(["commit", "-q", "-m", "tweak constant"], repoDir);

        // 5. Excluded: lockfile lines shouldn't push a tiny core change into >=15 lines
        writeFileSync(join(repoDir, "src/core.ts"), lines22 + "export const tiny = 2;\n");
        writeFileSync(
          join(repoDir, "package-lock.json"),
          Array.from({ length: 40 }, (_, i) => `"k${i}": ${i}`).join("\n") + "\n",
        );
        runGit(["add", "src/core.ts", "package-lock.json"], repoDir);
        runGit(["commit", "-q", "-m", "save lockfile state"], repoDir);

        const warns: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
        let selected: ReturnType<typeof mineHighSignalCommits> = [];
        try {
          selected = mineHighSignalCommits({
            repoRoot: repoDir,
            gitDepth: 50,
            maxCommits: 15,
            tokenBudget: 15_000,
            coreFilePaths: new Set(["src/core.ts"]),
          });
        } finally {
          console.warn = origWarn;
        }

        expect(selected.length).toBe(1);
        expect(selected[0]?.subject).toBe("update core handler");
        expect(warns.some((w) => w.includes("[git-miner] 0 keyword matches; fallback selected 1/1 commits touching Bucket A files"))).toBe(true);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe("2. args.ts --min-novelty parsing & defaults", () => {
    it("defaults minNovelty to 4 for repo mode and 3 for from-findings mode", () => {
      const repoOpts = parseCliArgs(["bun", "distill", "."]);
      expect(repoOpts.mode).toBe("repo");
      if (repoOpts.mode === "repo") expect(repoOpts.minNovelty).toBe(4);

      const findingsOpts = parseCliArgs(["bun", "distill", "from-findings", "notes.md", "--allow-ungrounded"]);
      expect(findingsOpts.mode).toBe("from-findings");
      if (findingsOpts.mode === "from-findings") expect(findingsOpts.minNovelty).toBe(3);
    });

    it("accepts explicit --min-novelty override in both modes", () => {
      const repoOpts = parseCliArgs(["bun", "distill", ".", "--min-novelty", "3"]);
      expect(repoOpts.mode).toBe("repo");
      if (repoOpts.mode === "repo") expect(repoOpts.minNovelty).toBe(3);

      const findingsOpts = parseCliArgs([
        "bun",
        "distill",
        "from-findings",
        "notes.md",
        "--allow-ungrounded",
        "--min-novelty",
        "5",
      ]);
      expect(findingsOpts.mode).toBe("from-findings");
      if (findingsOpts.mode === "from-findings") expect(findingsOpts.minNovelty).toBe(5);
    });

    it("exits with code 2 for out-of-range --min-novelty values (0 or 6)", () => {
      for (const badVal of ["0", "6"]) {
        const proc = Bun.spawnSync(["bun", "run", "bin/distill-anything.ts", ".", "--dry-run", "--min-novelty", badVal], {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(proc.exitCode).toBe(2);
      }
    });
  });

  describe("3. judge.ts gate enforcement", () => {
    it("keeps a 3/5 pattern when minNovelty=3 and drops 2/5 platitudes", () => {
      const score3Audit = {
        noveltyScore: 3,
        transferabilityScore: 4,
        antiTriggerQuality: "adequate" as const,
        verdict: "drop" as const,
        reasoning: "Partial overlap with baseline.",
      };
      const score2Audit = {
        noveltyScore: 2,
        transferabilityScore: 5,
        antiTriggerQuality: "strict" as const,
        verdict: "drop" as const,
        reasoning: "Standard idiom.",
      };

      expect(passesNoveltyThreshold(score3Audit, 4)).toBe(false);
      expect(passesNoveltyThreshold(score3Audit, 3)).toBe(true);
      expect(passesNoveltyThreshold(score2Audit, 3)).toBe(false);
    });
  });

  describe("4. render-pattern.ts Partial Baseline Overlap note", () => {
    it("emits Partial Baseline Overlap (3/5) note only when noveltyScore === 3", () => {
      const noteText = "Partial Baseline Overlap (3/5) — retained under min-novelty=3; verify value against your target model";

      const rendered3 = renderPatternFile(makeVerifiedPattern(3), "typescript");
      expect(rendered3.markdown).toContain(noteText);

      const rendered4 = renderPatternFile(makeVerifiedPattern(4), "typescript");
      expect(rendered4.markdown).not.toContain("Partial Baseline Overlap");

      const rendered5 = renderPatternFile(makeVerifiedPattern(5), "typescript");
      expect(rendered5.markdown).not.toContain("Partial Baseline Overlap");
    });
  });
});
