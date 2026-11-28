import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { CandidatePattern, EvidenceCitation } from "../../schemas/pattern";
import type { DroppedPatternLog } from "../../schemas/report";
import { isTestFilePath } from "../01-ingest";

export interface GroundingResult {
  groundedPatterns: CandidatePattern[];
  dropped: DroppedPatternLog[];
  groundingFailures: number;
  failureRate: number;
  errorSummary: string;
}

function normalizeLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
}

function tokenizeWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Computes token-overlap ratio (0..1) between two normalized code blocks. */
export function computeOverlapRatio(a: string, b: string): number {
  const wordsA = tokenizeWords(a);
  const wordsB = tokenizeWords(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const countsB = new Map<string, number>();
  for (const w of wordsB) {
    countsB.set(w, (countsB.get(w) ?? 0) + 1);
  }

  let matches = 0;
  for (const w of wordsA) {
    const c = countsB.get(w) ?? 0;
    if (c > 0) {
      matches += 1;
      countsB.set(w, c - 1);
    }
  }

  return matches / Math.max(wordsA.length, wordsB.length);
}

function verifyCitation(
  citation: EvidenceCitation,
  analysisRoot: string,
): { ok: true; citation: EvidenceCitation } | { ok: false; reason: string } {
  const root = resolve(analysisRoot);
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  const targetPath = resolve(root, citation.filePath);

  if (targetPath !== root && !targetPath.startsWith(normalizedRoot)) {
    return { ok: false, reason: `Path escapes analysisRoot: ${citation.filePath}` };
  }
  if (!existsSync(targetPath)) {
    return { ok: false, reason: `File not found: ${citation.filePath}` };
  }

  const fileLines = normalizeLines(readFileSync(targetPath, "utf8"));
  const snippetNorm = normalizeLines(citation.verbatimSnippet).join("\n");
  const hasExplicitRange =
    citation.startLine !== undefined &&
    citation.endLine !== undefined &&
    citation.startLine >= 1 &&
    citation.endLine >= citation.startLine;

  if (hasExplicitRange) {
    const startIdx = Math.max(0, citation.startLine! - 1);
    const endIdx = Math.min(fileLines.length, citation.endLine!);

    if (startIdx < endIdx) {
      const diskSlice = fileLines.slice(startIdx, endIdx).join("\n");
      if (computeOverlapRatio(diskSlice, snippetNorm) >= 0.85) {
        return {
          ok: true,
          citation: {
            ...citation,
            startLine: startIdx + 1,
            endLine: endIdx,
            verbatimSnippet: diskSlice,
          },
        };
      }
    }
  }

  // Sliding-window search to auto-correct off-by-N line number drift
  const snippetLineCount = Math.max(1, normalizeLines(citation.verbatimSnippet).length);
  let bestScore = 0;
  let bestStart = -1;
  let bestEnd = -1;

  for (let i = 0; i <= fileLines.length - snippetLineCount; i++) {
    const windowSlice = fileLines.slice(i, i + snippetLineCount).join("\n");
    if (windowSlice === snippetNorm) {
      bestScore = 1.01;
      bestStart = i;
      bestEnd = i + snippetLineCount;
      break;
    }
    const score = computeOverlapRatio(windowSlice, snippetNorm);
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
      bestEnd = i + snippetLineCount;
    }
  }

  if (bestScore >= 0.85 && bestStart >= 0) {
    const correctedSlice = fileLines.slice(bestStart, bestEnd).join("\n");
    return {
      ok: true,
      citation: {
        ...citation,
        startLine: bestStart + 1,
        endLine: bestEnd,
        verbatimSnippet: correctedSlice,
      },
    };
  }

  return {
    ok: false,
    reason: `Snippet mismatch in ${citation.filePath}:${citation.startLine}-${citation.endLine} (best overlap ${(bestScore * 100).toFixed(0)}%)`,
  };
}

/** Verifies every candidate pattern's citations against files on disk. */
export function groundCandidatePatterns(
  patterns: CandidatePattern[],
  analysisRoot: string,
  options?: { requireSourceCitation?: boolean },
): GroundingResult {
  const requireSource = options?.requireSourceCitation ?? false;
  const groundedPatterns: CandidatePattern[] = [];
  const dropped: DroppedPatternLog[] = [];
  const errors: string[] = [];

  for (const pattern of patterns) {
    const validCitations: EvidenceCitation[] = [];
    const patternErrors: string[] = [];

    for (const c of pattern.citations) {
      const check = verifyCitation(c, analysisRoot);
      if (check.ok) {
        validCitations.push(check.citation);
      } else {
        patternErrors.push(check.reason);
      }
    }

    const hasSourceCitation = validCitations.some((c) => !isTestFilePath(c.filePath));
    if (validCitations.length > 0 && (!requireSource || hasSourceCitation)) {
      groundedPatterns.push({
        ...pattern,
        citations: validCitations,
      });
    } else {
      const reason =
        validCitations.length > 0 && requireSource && !hasSourceCitation
          ? "All valid citations are test files; at least one primary source/implementation citation is required."
          : patternErrors.join("; ") || "No valid citations";
      dropped.push({
        patternId: pattern.id,
        title: pattern.title,
        stage: "grounder",
        reason,
      });
      errors.push(`Pattern "${pattern.id}": ${reason}`);
    }
  }

  const total = patterns.length;
  const groundingFailures = dropped.length;
  const failureRate = total > 0 ? groundingFailures / total : 1;

  return {
    groundedPatterns,
    dropped,
    groundingFailures,
    failureRate,
    errorSummary: errors.join("\n"),
  };
}
