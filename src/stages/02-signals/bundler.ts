import type { IngestResult, DiscoveredFile } from "../01-ingest";
import type { SignalBundle, SignalFile } from "../../schemas/signal-bundle";
import { countTokens, formatNumberedLines, truncateToTokens } from "../../core/tokens";
import { extractCoreArchitectureFiles } from "./ast-graph";
import { mineHighSignalCommits } from "./git-miner";
import { huntEdgeCaseTests } from "./test-hunter";

const TOTAL_SIGNAL_BUDGET = 60_000;
const BUCKET_B_BUDGET = 15_000;
const BUCKET_C_BUDGET = 10_000;
const BUCKET_D_BUDGET = 5_000;

function extractArchitectureDocs(files: DiscoveredFile[], tokenBudget: number): SignalFile[] {
  const docFiles = files.filter((f) => f.language === "markdown");
  if (docFiles.length === 0 || tokenBudget <= 0) return [];

  const prioritized = docFiles
    .map((f) => {
      const lower = f.relPath.toLowerCase();
      let priority = 0;
      if (lower.includes("docs/adr/") || lower.includes("architecture") || lower === "design.md") {
        priority = 10;
      } else if (lower === "readme.md") {
        priority = 5;
      }
      return { file: f, priority };
    })
    .filter((x) => x.priority > 0)
    .sort((a, b) => b.priority - a.priority);

  const selected: SignalFile[] = [];
  let usedTokens = 0;

  for (const { file, priority } of prioritized) {
    const remaining = tokenBudget - usedTokens;
    if (remaining < 200) break;
    const numbered = formatNumberedLines(file.content);
    const { text, truncated } = truncateToTokens(numbered, Math.min(remaining, 2500));
    const tokenCount = countTokens(text);
    if (tokenCount <= 0) continue;

    selected.push({
      path: file.relPath,
      bucket: "architecture_doc",
      language: "markdown",
      score: priority,
      fanIn: 0,
      tokenCount,
      truncated,
      numberedContent: text,
    });
    usedTokens += tokenCount;
  }

  return selected;
}

/** Assembles the deterministic <=60k token SignalBundle across Buckets A-D. */
export async function buildSignalBundle(params: {
  ingest: IngestResult;
  maxFiles: number;
  maxCommits: number;
  gitDepth: number;
}): Promise<SignalBundle> {
  const { ingest, maxFiles, maxCommits, gitDepth } = params;

  const docs = extractArchitectureDocs(ingest.files, BUCKET_D_BUDGET);
  const docsTokens = docs.reduce((sum, d) => sum + d.tokenCount, 0);

  const maxTestFiles = Math.max(1, Math.floor(maxFiles * 0.25));
  const maxCoreFiles = Math.max(1, Math.ceil(maxFiles * 0.65));

  // Preliminary core selection to inform test-hunter and git-miner
  const prelimCoreBudget = TOTAL_SIGNAL_BUDGET - BUCKET_B_BUDGET - BUCKET_C_BUDGET - docsTokens;
  const prelimCore = await extractCoreArchitectureFiles({
    files: ingest.files,
    maxFiles: maxCoreFiles,
    tokenBudget: prelimCoreBudget,
    analysisRoot: ingest.analysisRoot,
  });

  const commits = ingest.isGitRepo
    ? mineHighSignalCommits({
        repoRoot: ingest.repoRoot,
        gitDepth,
        maxCommits,
        tokenBudget: BUCKET_B_BUDGET,
        coreFilePaths: prelimCore.coreFilePaths,
      })
    : [];
  const commitsTokens = commits.reduce((sum, c) => sum + c.tokenCount, 0);

  const tests = huntEdgeCaseTests({
    files: ingest.files,
    coreFilePaths: prelimCore.coreFilePaths,
    maxFiles: maxTestFiles,
    tokenBudget: BUCKET_C_BUDGET,
  });
  const testsTokens = tests.reduce((sum, t) => sum + t.tokenCount, 0);

  // Unused tokens from Buckets B/C/D roll over into Bucket A
  const finalCoreBudget = TOTAL_SIGNAL_BUDGET - commitsTokens - testsTokens - docsTokens;
  const core =
    finalCoreBudget > prelimCoreBudget
      ? await extractCoreArchitectureFiles({
          files: ingest.files,
          maxFiles: maxCoreFiles,
          tokenBudget: finalCoreBudget,
          analysisRoot: ingest.analysisRoot,
        })
      : prelimCore;

  const allFiles = [...core.selected, ...tests, ...docs];
  const totalTokens =
    allFiles.reduce((sum, f) => sum + f.tokenCount, 0) + commitsTokens;

  return {
    profile: ingest.profile,
    totalTokens,
    files: allFiles,
    commits,
  };
}
