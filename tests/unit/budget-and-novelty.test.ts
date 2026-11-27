import { describe, expect, it } from "bun:test";
import { BudgetExceededError, BudgetLedger } from "../../src/core/budget";
import { passesNoveltyThreshold } from "../../src/stages/04-novelty/judge";

describe("BudgetLedger", () => {
  it("tracks usage and throws BudgetExceededError before exceeding cap", () => {
    const ledger = new BudgetLedger(0.05);
    ledger.recordUsage("miner", "openai:gpt-4.1-mini", 10_000, 2_000, 500);
    expect(ledger.getTotalCostUsd()).toBeGreaterThan(0);

    expect(() =>
      ledger.assertWithinBudget("anthropic:claude-opus-4-5", "hello world ".repeat(3500), 4096),
    ).toThrow(BudgetExceededError);
  });
});

describe("Novelty Gate deterministic threshold", () => {
  it("requires verdict=keep, novelty>=4, transferability>=3, antiTriggerQuality!=weak", () => {
    expect(
      passesNoveltyThreshold({
        noveltyScore: 4,
        transferabilityScore: 3,
        antiTriggerQuality: "adequate",
        verdict: "keep",
        reasoning: "Valid architectural delta with clear anti-triggers.",
      }),
    ).toBe(true);

    expect(
      passesNoveltyThreshold({
        noveltyScore: 3,
        transferabilityScore: 5,
        antiTriggerQuality: "strict",
        verdict: "keep",
        reasoning: "Judge said keep but score is 3.",
      }),
    ).toBe(false);

    expect(
      passesNoveltyThreshold({
        noveltyScore: 5,
        transferabilityScore: 4,
        antiTriggerQuality: "weak",
        verdict: "keep",
        reasoning: "Weak anti-triggers should be rejected.",
      }),
    ).toBe(false);
  });
});
