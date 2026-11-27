import type { BudgetLedger } from "../../core/budget";
import type { ReasoningEffort } from "../../core/config";
import { callTextLlm } from "../../core/llm";
import { loadPromptTemplate, renderTemplate } from "../../core/prompts";
import { countTokens } from "../../core/tokens";

const MIN_BASELINE_TOKENS = 60;

export class StubBaselineError extends Error {
  constructor(tokenCount: number) {
    super(
      `Novelty baseline generation returned a stub (${tokenCount} tokens < ${MIN_BASELINE_TOKENS} minimum) even after retry.`,
    );
    this.name = "StubBaselineError";
  }
}

/** Generates a blind baseline solution from ONLY the problemStatement & language. */
export async function generateBlindBaseline(params: {
  primaryLanguage: string;
  problemStatement: string;
  judgeModelId: string;
  judgeReasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  budget: BudgetLedger;
  llmCall?: typeof callTextLlm;
}): Promise<string> {
  const template = loadPromptTemplate("novelty-baseline.md");
  const prompt = renderTemplate(template, {
    primaryLanguage: params.primaryLanguage,
    problemStatement: params.problemStatement,
  });
  const invoke = params.llmCall ?? callTextLlm;

  for (const maxOutputTokens of [1200, 1600]) {
    const { text } = await invoke({
      stage: "novelty_baseline",
      modelId: params.judgeModelId,
      reasoningEffort: params.judgeReasoningEffort,
      codexPath: params.codexPath,
      prompt,
      maxOutputTokens,
      budget: params.budget,
    });
    const tokens = countTokens(text.trim());
    if (tokens >= MIN_BASELINE_TOKENS) {
      return text;
    }
    if (maxOutputTokens === 1600) {
      throw new StubBaselineError(tokens);
    }
  }

  throw new StubBaselineError(0);
}
