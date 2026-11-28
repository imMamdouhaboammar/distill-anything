import type { CandidatePattern } from "../../schemas/pattern";
import { NoveltyJudgeOutputSchema, type NoveltyJudgeOutput, type VerifiedPattern } from "../../schemas/novelty";
import type { DroppedPatternLog } from "../../schemas/report";
import type { BudgetLedger } from "../../core/budget";
import type { ReasoningEffort } from "../../core/config";
import { callStructuredLlm } from "../../core/llm";
import { loadPromptTemplate, renderTemplate } from "../../core/prompts";
import { generateBlindBaseline } from "./baseline";

export function passesNoveltyThreshold(audit: NoveltyJudgeOutput, minNovelty = 4): boolean {
  return (
    audit.noveltyScore >= minNovelty &&
    audit.transferabilityScore >= 3 &&
    audit.antiTriggerQuality !== "weak"
  );
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function runNext(): Promise<void> {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      const item = items[idx];
      if (item !== undefined) {
        results[idx] = await worker(item);
      }
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(runners);
  return results;
}

/** Runs Stage 4 Blind Baseline + Head-to-Head Judge with concurrency limit 4. */
export async function runNoveltyGate(params: {
  patterns: CandidatePattern[];
  primaryLanguage: string;
  judgeModelId: string;
  judgeReasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  budget: BudgetLedger;
  minNovelty?: number;
}): Promise<{ kept: VerifiedPattern[]; dropped: DroppedPatternLog[] }> {
  const judgeTemplate = loadPromptTemplate("novelty-judge.md");
  const minNovelty = params.minNovelty ?? 3;

  const evaluations = await runWithConcurrency(params.patterns, 4, async (pattern) => {
    const blindBaseline = await generateBlindBaseline({
      primaryLanguage: params.primaryLanguage,
      problemStatement: pattern.problemStatement,
      judgeModelId: params.judgeModelId,
      judgeReasoningEffort: params.judgeReasoningEffort,
      codexPath: params.codexPath,
      budget: params.budget,
    });

    const prompt = renderTemplate(judgeTemplate, {
      problemStatement: pattern.problemStatement,
      blindBaseline,
      title: pattern.title,
      category: pattern.category,
      naiveApproach: pattern.naiveApproach,
      repoApproach: pattern.repoApproach,
      tradeOffs: pattern.tradeOffs.join("; "),
      whenToApply: pattern.whenToApply.join("; "),
      antiTriggers: pattern.antiTriggers.join("; "),
      transferableRule: pattern.transferableRule,
    });

    const { object: audit } = await callStructuredLlm({
      stage: "novelty_judge",
      modelId: params.judgeModelId,
      reasoningEffort: params.judgeReasoningEffort,
      codexPath: params.codexPath,
      prompt,
      schema: NoveltyJudgeOutputSchema,
      maxOutputTokens: 500,
      budget: params.budget,
    });

    return { pattern, blindBaseline, audit };
  });

  const kept: VerifiedPattern[] = [];
  const dropped: DroppedPatternLog[] = [];

  for (const ev of evaluations) {
    if (passesNoveltyThreshold(ev.audit, minNovelty)) {
      kept.push({
        pattern: ev.pattern,
        groundingVerified: true,
        blindBaselineSummary: ev.blindBaseline,
        audit: ev.audit,
      });
    } else {
      dropped.push({
        patternId: ev.pattern.id,
        title: ev.pattern.title,
        stage: "novelty_gate",
        reason: ev.audit.reasoning,
        noveltyScore: ev.audit.noveltyScore,
      });
    }
  }

  return { kept, dropped };
}
