import type { SignalBundle } from "../../schemas/signal-bundle";
import { PatternMiningOutputSchema, type CandidatePattern } from "../../schemas/pattern";
import type { DroppedPatternLog } from "../../schemas/report";
import type { BudgetLedger } from "../../core/budget";
import type { ReasoningEffort } from "../../core/config";
import { callStructuredLlm } from "../../core/llm";
import { loadPromptTemplate, renderTemplate } from "../../core/prompts";
import { groundCandidatePatterns } from "./grounder";

export class GroundingFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroundingFailureError";
  }
}

export interface MiningResult {
  repoDomainSummary: string;
  operatingConstraints: string[];
  groundedPatterns: CandidatePattern[];
  totalCandidatesExtracted: number;
  groundingFailures: number;
  droppedByGrounder: DroppedPatternLog[];
}

function buildMinerUserPrompt(bundle: SignalBundle, groundingFeedback?: string): string {
  const userTemplate = loadPromptTemplate("miner-user.md");

  const filesSection = bundle.files
    .map(
      (f) =>
        `### File: ${f.path} (${f.language}, bucket=${f.bucket}, fanIn=${f.fanIn})\n\`\`\`${f.language}\n${f.numberedContent}\n\`\`\``,
    )
    .join("\n\n");

  const commitsSection =
    bundle.commits.length > 0
      ? bundle.commits
          .map(
            (c) =>
              `### Commit ${c.sha.slice(0, 8)} (${c.date}): ${c.subject}\n${c.body ? `${c.body}\n` : ""}\`\`\`diff\n${c.diff}\n\`\`\``,
          )
          .join("\n\n")
      : "_No high-signal git commits available._";

  return renderTemplate(userTemplate, {
    repoName: bundle.profile.repoName,
    primaryLanguage: bundle.profile.primaryLanguage,
    maturityClassification: bundle.profile.maturity.classification,
    subpath: bundle.profile.subpath,
    groundingFeedback,
    filesSection,
    commitsSection,
  });
}

/** Runs Stage 3 Pattern Mining with one automatic grounding-repair retry if >50% fail. */
export async function minePatterns(params: {
  bundle: SignalBundle;
  analysisRoot: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  budget: BudgetLedger;
  llmCall?: typeof callStructuredLlm;
}): Promise<MiningResult> {
  const systemPrompt = loadPromptTemplate("miner-system.md");
  const invokeLlm = params.llmCall ?? callStructuredLlm;
  let feedback: string | undefined;
  let lastDropped: DroppedPatternLog[] = [];
  let totalExtracted = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const userPrompt = buildMinerUserPrompt(params.bundle, feedback);
    const { object } = await invokeLlm({
      stage: "miner",
      modelId: params.modelId,
      reasoningEffort: params.reasoningEffort,
      codexPath: params.codexPath,
      system: systemPrompt,
      prompt: userPrompt,
      schema: PatternMiningOutputSchema,
      maxOutputTokens: 4096,
      budget: params.budget,
    });

    totalExtracted += object.patterns.length;
    const hasSourceFiles = params.bundle.files.some((f) => f.bucket === "core_architecture");
    const grounded = groundCandidatePatterns(object.patterns, params.analysisRoot, {
      requireSourceCitation: hasSourceFiles,
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
