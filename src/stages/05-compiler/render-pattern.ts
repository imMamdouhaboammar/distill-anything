import { extname } from "node:path";
import type { VerifiedPattern } from "../../schemas/novelty";
import { countTokens } from "../../core/tokens";

const PATTERN_HARD_CAP = 900;

const EXT_TO_FENCE: Record<string, string> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".h": "cpp",
  ".c": "c",
  ".md": "markdown",
  ".sql": "sql",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

function inferFenceLanguage(filePath: string, fallback: string): string {
  return EXT_TO_FENCE[extname(filePath).toLowerCase()] ?? fallback;
}

function formatPatternMarkdown(
  vp: VerifiedPattern,
  primaryLanguage: string,
  snippetMaxLines?: number,
): string {
  const { pattern, audit } = vp;
  const lines: string[] = [
    `# ${pattern.title}`,
    "",
    `- **Category**: \`${pattern.category}\``,
    `- **Maturity**: \`${pattern.maturityTag}\``,
    `- **Evidence**: \`${pattern.evidenceStatus}\``,
    `- **Novelty Audit**: \`${audit.noveltyScore}/5\` (Transferability: \`${audit.transferabilityScore}/5\`)`,
    ...(audit.noveltyScore === 3
      ? ["- **Note**: Partial Baseline Overlap (3/5) — retained under min-novelty=3; verify value against your target model"]
      : []),
    "",
    "## Problem",
    pattern.problemStatement,
    "",
    "## Default Approach (And Why It Breaks)",
    pattern.naiveApproach,
    "",
    "## Repository Pattern",
    pattern.repoApproach,
    "",
    "## Verified Source Evidence",
  ];

  for (const c of pattern.citations) {
    const commitPart = c.commitSha ? ` · Commit \`${c.commitSha}\`` : "";
    let snippet = c.verbatimSnippet;
    let endLine = c.endLine;

    let condensedNote = "";
    if (snippetMaxLines !== undefined) {
      const sLines = snippet.split("\n");
      if (sLines.length > snippetMaxLines) {
        snippet = `${sLines.slice(0, snippetMaxLines).join("\n")}\n// ... [condensed for token budget]`;
        endLine = Math.min(c.endLine, c.startLine + snippetMaxLines - 1);
        condensedNote = " *(excerpt condensed)*";
      }
    }

    const fenceLang = inferFenceLanguage(c.filePath, primaryLanguage);
    lines.push(
      `**\`${c.filePath}\` (Lines ${c.startLine}–${endLine})**${commitPart}${condensedNote}`,
      `\`\`\`${fenceLang}`,
      snippet,
      "```",
      "",
    );
  }

  lines.push("## Trade-Offs", "");
  for (const t of pattern.tradeOffs) lines.push(`* ${t}`);

  lines.push("", "## When to Apply", "");
  for (const w of pattern.whenToApply) lines.push(`* ${w}`);

  lines.push("", "## Anti-Triggers (Do NOT Apply When)", "");
  for (const a of pattern.antiTriggers) lines.push(`* ${a}`);

  return `${lines.join("\n")}\n`;
}

/** Renders an individual pattern file and enforces the <= 900 token hard cap. */
export function renderPatternFile(
  vp: VerifiedPattern,
  primaryLanguage: string,
): { markdown: string; tokenCount: number } {
  let markdown = formatPatternMarkdown(vp, primaryLanguage);
  let tokens = countTokens(markdown);
  if (tokens <= PATTERN_HARD_CAP) {
    return { markdown, tokenCount: tokens };
  }

  for (const maxLines of [25, 15, 8, 4]) {
    markdown = formatPatternMarkdown(vp, primaryLanguage, maxLines);
    tokens = countTokens(markdown);
    if (tokens <= PATTERN_HARD_CAP) {
      return { markdown, tokenCount: tokens };
    }
  }

  return { markdown, tokenCount: tokens };
}
