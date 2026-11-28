import { countTokens } from "./tokens";
import type { StageCost } from "../schemas/report";

export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "anthropic:claude-sonnet-4-5": { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  "anthropic:claude-sonnet-4-0": { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  "anthropic:claude-haiku-4-5": { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4.0 },
  "anthropic:claude-opus-4-5": { inputPerMillionUsd: 15.0, outputPerMillionUsd: 75.0 },
  "openai:gpt-4.1-mini": { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6 },
  "openai:gpt-4.1": { inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0 },
  "openai:gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "openai:gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0 },
  "google:gemini-2.5-flash": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "google:gemini-2.5-pro": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0 },
  "gcloud:gemini-2.5-flash": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "gcloud:gemini-2.5-pro": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0 },
  "codex:gpt-6.2-sol": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0 },
  "codex:gpt-6.2-astra": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0 },
  "codex:gpt-6.1-terra": { inputPerMillionUsd: 2.25, outputPerMillionUsd: 9.0 },
  "codex:gpt-6.1-sol": { inputPerMillionUsd: 2.25, outputPerMillionUsd: 9.0 },
  "codex:gpt-6-astra": { inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0 },
  "codex:gpt-6-sol": { inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0 },
  "codex:gpt-6-luna": { inputPerMillionUsd: 1.5, outputPerMillionUsd: 6.0 },
  "codex:gpt-5.6-sol": { inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0 },
  "codex:gpt-5.6-terra": { inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0 },
  "codex:gpt-5.6-luna": { inputPerMillionUsd: 1.5, outputPerMillionUsd: 6.0 },
  "codex:gpt-5.4": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0 },
  "codex:gpt-5.3-codex": { inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0 },
  "codex:gpt-5.2-codex": { inputPerMillionUsd: 1.75, outputPerMillionUsd: 7.0 },
  "codex:gpt-5.1-codex": { inputPerMillionUsd: 1.5, outputPerMillionUsd: 6.0 },
  "codex:gpt-5-codex": { inputPerMillionUsd: 1.5, outputPerMillionUsd: 6.0 },
  "codex:gpt-5": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0 },
  "codex:o3": { inputPerMillionUsd: 2.0, outputPerMillionUsd: 8.0 },
  "codex:o4-mini": { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4 },
  "codex:codex-mini-latest": { inputPerMillionUsd: 1.5, outputPerMillionUsd: 6.0 },
  "codex:default": { inputPerMillionUsd: 1.5, outputPerMillionUsd: 6.0 },
};

const FALLBACK_PRICING: ModelPricing = { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 };

export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly estimatedCallUsd: number,
    public readonly maxBudgetUsd: number,
  ) {
    super(
      `Budget cap exceeded: spent $${spentUsd.toFixed(4)} + est. $${estimatedCallUsd.toFixed(4)} > cap $${maxBudgetUsd.toFixed(4)}`,
    );
    this.name = "BudgetExceededError";
  }
}

import { z } from "zod";

const PricingTableSchema = z.record(
  z.string(),
  z.object({
    inputPerMillionUsd: z.number().nonnegative(),
    outputPerMillionUsd: z.number().nonnegative(),
  }),
);

function loadPricingTable(): Record<string, ModelPricing> {
  const custom = process.env.DISTILL_PRICING_JSON;
  if (!custom) return DEFAULT_PRICING;
  try {
    const parsed = PricingTableSchema.parse(JSON.parse(custom));
    return { ...DEFAULT_PRICING, ...parsed };
  } catch {
    return DEFAULT_PRICING;
  }
}

export class BudgetLedger {
  private readonly pricing: Record<string, ModelPricing>;
  private readonly entries: StageCost[] = [];
  private spentUsd = 0;

  constructor(public readonly maxBudgetUsd: number) {
    this.pricing = loadPricingTable();
  }

  getPricing(modelId: string): ModelPricing {
    if (this.pricing[modelId]) return this.pricing[modelId];
    if (modelId.startsWith("codex:") && this.pricing["codex:default"]) {
      return this.pricing["codex:default"];
    }
    return FALLBACK_PRICING;
  }

  estimateCallCost(modelId: string, inputTokens: number, maxOutputTokens: number): number {
    const p = this.getPricing(modelId);
    return (inputTokens / 1_000_000) * p.inputPerMillionUsd + (maxOutputTokens / 1_000_000) * p.outputPerMillionUsd;
  }

  /** Throws BudgetExceededError if executing this call could exceed maxBudgetUsd. */
  assertWithinBudget(modelId: string, promptText: string, maxOutputTokens: number): number {
    const inputTokens = countTokens(promptText);
    const est = this.estimateCallCost(modelId, inputTokens, maxOutputTokens);
    if (this.spentUsd + est > this.maxBudgetUsd) {
      throw new BudgetExceededError(this.spentUsd, est, this.maxBudgetUsd);
    }
    return est;
  }

  recordUsage(
    stage: StageCost["stage"],
    model: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
  ): StageCost {
    const p = this.getPricing(model);
    const costUsd =
      (inputTokens / 1_000_000) * p.inputPerMillionUsd + (outputTokens / 1_000_000) * p.outputPerMillionUsd;
    this.spentUsd += costUsd;
    const entry: StageCost = {
      stage,
      model,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
    };
    this.entries.push(entry);
    return entry;
  }

  getTotalCostUsd(): number {
    return this.spentUsd;
  }

  getEntries(): StageCost[] {
    return [...this.entries];
  }
}
