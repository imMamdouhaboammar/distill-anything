import { z } from "zod";
import { CandidatePatternSchema } from "./pattern";

export const NoveltyJudgeOutputSchema = z.object({
  noveltyScore: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("1=Baseline already solved identically; 3=Minor improvement; 4=Meaningful architectural delta; 5=Non-obvious technique baseline missed completely."),
  transferabilityScore: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("1=Coupled tightly to repo internals; 5=Cleanly transferable to other projects with clear anti-triggers."),
  antiTriggerQuality: z.enum(["weak", "adequate", "strict"]),
  verdict: z.enum(["keep", "drop"]),
  reasoning: z.string().min(30).max(2000).describe("Concise 1-2 sentence justification under 500 characters."),
});

export const VerifiedPatternSchema = z.object({
  pattern: CandidatePatternSchema,
  groundingVerified: z.boolean(),
  blindBaselineSummary: z.string(),
  audit: NoveltyJudgeOutputSchema,
});

export type NoveltyJudgeOutput = z.infer<typeof NoveltyJudgeOutputSchema>;
export type VerifiedPattern = z.infer<typeof VerifiedPatternSchema>;
