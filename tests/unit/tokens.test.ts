import { describe, expect, it } from "bun:test";
import { countTokens, formatNumberedLines, truncateToTokens } from "../../src/core/tokens";

describe("tokens.ts", () => {
  it("counts tokens deterministically", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("export const x = 42;")).toBeGreaterThan(0);
  });

  it("truncates to maxTokens while preserving whole lines", () => {
    const text = Array.from({ length: 50 }, (_, i) => `const line${i} = "value-${i}";`).join("\n");
    const { text: out, truncated } = truncateToTokens(text, 40);
    expect(truncated).toBe(true);
    expect(countTokens(out)).toBeLessThanOrEqual(40);
    expect(out.split("\n").every((l) => l.endsWith(";"))).toBe(true);
  });

  it("formats 1-indexed zero-padded line numbers", () => {
    const numbered = formatNumberedLines("alpha\nbeta\ngamma");
    expect(numbered).toBe("0001 | alpha\n0002 | beta\n0003 | gamma");
  });
});
