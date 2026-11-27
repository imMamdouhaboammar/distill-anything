import type { SignalBundle } from "../schemas/signal-bundle";
import type { DistillReport } from "../schemas/report";
import type { BudgetLedger } from "../core/budget";

export class Reporter {
  constructor(private readonly jsonMode: boolean) {}

  info(message: string): void {
    if (!this.jsonMode) {
      console.log(message);
    }
  }

  warn(message: string): void {
    console.error(`[warn] ${message}`);
  }

  error(message: string): void {
    console.error(`[error] ${message}`);
  }

  printDryRun(bundle: SignalBundle, minerModel: string, budget: BudgetLedger): void {
    const estCost = budget.estimateCallCost(minerModel, bundle.totalTokens, 4096);
    if (this.jsonMode) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            profile: bundle.profile,
            totalTokens: bundle.totalTokens,
            filesIncluded: bundle.files.length,
            commitsIncluded: bundle.commits.length,
            estimatedMinerCostUsd: Number(estCost.toFixed(4)),
            files: bundle.files.map((f) => ({
              path: f.path,
              bucket: f.bucket,
              language: f.language,
              score: Number(f.score.toFixed(2)),
              fanIn: f.fanIn,
              tokenCount: f.tokenCount,
              truncated: f.truncated,
            })),
            commits: bundle.commits.map((c) => ({
              sha: c.sha.slice(0, 7),
              date: c.date,
              subject: c.subject,
              score: Number(c.score.toFixed(2)),
              tokenCount: c.tokenCount,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    const p = bundle.profile;
    console.log(`\n=== distill-anything dry-run ===`);
    console.log(`Repo:        ${p.repoName} (${p.skillSlug})`);
    console.log(`Commit:      ${p.commitSha ?? "none"}`);
    console.log(`Primary:     ${p.primaryLanguage}`);
    console.log(`Maturity:    ${p.maturity.classification} (CI=${p.maturity.hasCiWorkflows}, Bench=${p.maturity.hasBenchmarks}, Strict=${p.maturity.hasStrictTyping})`);
    console.log(`Files:       ${p.totalFilesScanned} scanned -> ${bundle.files.length} selected`);
    console.log(`Commits:     ${bundle.commits.length} high-signal diffs selected`);
    console.log(`Tokens:      ${bundle.totalTokens.toLocaleString()} / 60,000`);
    console.log(`Est. Miner:  $${estCost.toFixed(4)} (${minerModel})\n`);
    for (const f of bundle.files) {
      console.log(
        `  [${f.bucket.padEnd(17)}] ${f.path} (score=${f.score.toFixed(2)}, fanIn=${f.fanIn}, tokens=${f.tokenCount}${f.truncated ? ", truncated" : ""})`,
      );
    }
  }

  printReport(report: DistillReport): void {
    if (this.jsonMode) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`\n=== distill-anything complete ===`);
    console.log(`Output:      ${report.outputPath}`);
    console.log(`Candidates:  ${report.totalCandidatesExtracted} extracted, ${report.groundingFailures} failed grounding`);
    console.log(`Kept:        ${report.patternsKept} verified patterns`);
    console.log(`SKILL.md:    ${report.skillIndexTokens} / 1,200 tokens`);
    console.log(`Total Cost:  $${report.totalCostUsd.toFixed(4)}`);
  }
}
