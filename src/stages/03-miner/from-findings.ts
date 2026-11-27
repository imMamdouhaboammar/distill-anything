import { existsSync, readFileSync } from "node:fs";
import type { BudgetLedger } from "../../core/budget";
import type { ReasoningEffort } from "../../core/config";
import { callStructuredLlm } from "../../core/llm";
import { loadPromptTemplate, renderTemplate } from "../../core/prompts";
import { truncateToTokens } from "../../core/tokens";
import { PatternMiningOutputSchema } from "../../schemas/pattern";
import type { DroppedPatternLog } from "../../schemas/report";
import { GroundingFailureError, type MiningResult } from "./extract";
import { groundCandidatePatterns } from "./grounder";

const MAX_FINDINGS_TOKENS = 40_000;

export interface FromFindingsParams {
  findingsFile: string;
  repoName: string;
  primaryLanguage: string;
  analysisRoot?: string | undefined;
  allowUngrounded: boolean;
  modelId: string;
  reasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  budget: BudgetLedger;
  llmCall?: typeof callStructuredLlm;
}

/**
 * Structures raw findings from a conversation into CandidatePattern[]
 * and grounds them against disk unless allowUngrounded is set.
 */
export async function extractPatternsFromFindings(params: FromFindingsParams): Promise<MiningResult> {
  if (!existsSync(params.findingsFile)) {
    throw new Error(`Findings file not found: ${params.findingsFile}`);
  }

  const rawContent = readFileSync(params.findingsFile, "utf8");
  if (rawContent.trim().length === 0) {
    throw new Error(`Findings file is empty: ${params.findingsFile}`);
  }

  const { text: findingsText } = truncateToTokens(rawContent, MAX_FINDINGS_TOKENS);
  const template = loadPromptTemplate("findings-structurer.md");
  const invokeLlm = params.llmCall ?? callStructuredLlm;
  const shouldGround = !params.allowUngrounded && Boolean(params.analysisRoot);
  const groundingMode = shouldGround ? "verified_disk" : "ungrounded_notes";

  let feedback: string | undefined;
  let lastDropped: DroppedPatternLog[] = [];
  let totalExtracted = 0;

  const maxAttempts = shouldGround ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const prompt = renderTemplate(template, {
      repoName: params.repoName,
      primaryLanguage: params.primaryLanguage,
      groundingMode,
      groundingFeedback: feedback ? `PREVIOUS EXTRACTION HAD GROUNDING ERRORS:\n${feedback}` : "",
      findingsText,
    });

    const { object } = await invokeLlm({
      stage: "miner",
      modelId: params.modelId,
      reasoningEffort: params.reasoningEffort,
      codexPath: params.codexPath,
      prompt,
      schema: PatternMiningOutputSchema,
      maxOutputTokens: 4096,
      budget: params.budget,
    });

    totalExtracted += object.patterns.length;

    if (!shouldGround || !params.analysisRoot) {
      return {
        repoDomainSummary: object.repoDomainSummary,
        operatingConstraints: object.operatingConstraints,
        groundedPatterns: object.patterns,
        totalCandidatesExtracted: totalExtracted,
        groundingFailures: 0,
        droppedByGrounder: [],
      };
    }

    const grounded = groundCandidatePatterns(object.patterns, params.analysisRoot, {
      requireSourceCitation: false,
    });
    lastDropped = grounded.dropped;

    if (grounded.failureRate <= 0.5 && grounded.groundedPatterns.length > 0) {
      return {
        repoDomainSummary: object.repoDomainSummary,
        operatingConstraints: object.operatingConstraints,
        groundedPatterns: grounded.groundedPatterns,
        totalCandidatesExtracted: totalExtracted,
        groundingFailures: grounded.groundingFailures,
        droppedByGrounder: grounded.dropped,
      };
    }

    if (attempt === 0) {
      feedback = grounded.errorSummary || "All citations failed verification against disk files.";
    }
  }

  throw new GroundingFailureError(
    `Grounding failed on retry (${lastDropped.length} patterns dropped).`,
  );
}
