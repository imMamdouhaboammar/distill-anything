import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = getEncoding("cl100k_base");
  }
  return encoder;
}

/** Counts tokens using cl100k_base encoding. */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/** Truncates text to fit within maxTokens while preserving whole lines when possible. */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: "", truncated: text.length > 0 };
  const enc = getEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) {
    return { text, truncated: false };
  }
  const sliced = enc.decode(tokens.slice(0, maxTokens));
  const lastNewline = sliced.lastIndexOf("\n");
  const clean = lastNewline > sliced.length * 0.5 ? sliced.slice(0, lastNewline) : sliced;
  return { text: clean, truncated: true };
}

/** Formats source lines with 1-indexed zero-padded line numbers (`0001 | ...`). */
export function formatNumberedLines(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const width = Math.max(4, String(lines.length).length);
  return lines
    .map((line, idx) => `${String(idx + 1).padStart(width, "0")} | ${line}`)
    .join("\n");
}
