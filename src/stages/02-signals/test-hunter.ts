import type { DiscoveredFile } from "../01-ingest";
import type { SignalFile } from "../../schemas/signal-bundle";
import { countTokens, formatNumberedLines, truncateToTokens } from "../../core/tokens";

const EDGE_CASE_KEYWORDS =
  /\b(race|concurrent|overflow|timeout|retry|corrupt|empty|boundary|crash|recover|fuzz|property|invariant|deadlock|cancel|abort)\b/gi;

/** Ranks edge-case test files that exercise core architecture modules. */
export function huntEdgeCaseTests(params: {
  files: DiscoveredFile[];
  coreFilePaths: Set<string>;
  maxFiles: number;
  tokenBudget: number;
}): SignalFile[] {
  const testFiles = params.files.filter((f) => f.isTest);
  if (testFiles.length === 0 || params.maxFiles <= 0 || params.tokenBudget <= 0) return [];

  const coreBasenames = Array.from(params.coreFilePaths).map((p) =>
    p.replace(/\.[^.]+$/, "").split("/").pop() ?? "",
  ).filter(Boolean);

  const scored = testFiles.map((f) => {
    const keywordMatches = f.content.match(EDGE_CASE_KEYWORDS)?.length ?? 0;
    let importsCore = 0;
    for (const base of coreBasenames) {
      if (f.content.includes(base)) importsCore += 1;
    }
    const score = keywordMatches * 1.2 + Math.min(importsCore, 5) * 2.0;
    return { file: f, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: SignalFile[] = [];
  let usedTokens = 0;

  for (const { file, score } of scored) {
    if (selected.length >= params.maxFiles) break;
    const remaining = params.tokenBudget - usedTokens;
    if (remaining < 250) break;

    const numbered = formatNumberedLines(file.content);
    const { text, truncated } = truncateToTokens(numbered, Math.min(remaining, 3500));
    const tokenCount = countTokens(text);
    if (tokenCount <= 0) continue;

    selected.push({
      path: file.relPath,
      bucket: "edge_case_test",
      language: file.language,
      score,
      fanIn: 0,
      tokenCount,
      truncated,
      numberedContent: text,
    });
    usedTokens += tokenCount;
  }

  return selected;
}
