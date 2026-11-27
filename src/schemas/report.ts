import { z } from "zod";
import { RepoProfileSchema } from "./repo-profile";

export const StageCostSchema = z.object({
  stage: z.enum(["miner", "novelty_baseline", "novelty_judge", "merge_synthesizer", "incremental_updater"]),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export const DroppedPatternLogSchema = z.object({
  patternId: z.string(),
  title: z.string(),
  stage: z.enum(["grounder", "novelty_gate", "merge_overflow"]),
  reason: z.string(),
  noveltyScore: z.number().int().min(1).max(5).optional(),
});

export const PartialOverlapPatternLogSchema = z.object({
  patternId: z.string(),
  title: z.string(),
  noveltyScore: z.number().int().min(1).max(5),
  note: z.string(),
});

export const GroundingModeSchema = z.enum(["verified_disk", "ungrounded_notes"]);

export const UpdateHistoryEntrySchema = z.object({
  fromSha: z.string(),
  toSha: z.string(),
  promoted: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  deprecated: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  updatedAt: z.string(),
});

export const MergedSourceInfoSchema = z.object({
  skillSlug: z.string(),
  repoName: z.string(),
  source: z.string(),
  commitSha: z.string().nullable(),
});

export const DistillReportSchema = z.object({
  version: z.literal("1.0"),
  tool: z.string().optional(),
  provider: z.string().optional(),
  profile: RepoProfileSchema,
  outputPath: z.string(),
  groundingMode: GroundingModeSchema.optional(),
  minNovelty: z.number().int().min(1).max(5).optional(),
  totalCandidatesExtracted: z.number().int().nonnegative(),
  groundingFailures: z.number().int().nonnegative(),
  patternsKept: z.number().int().nonnegative(),
  patternsDropped: z.array(DroppedPatternLogSchema),
  partialOverlapPatterns: z.array(PartialOverlapPatternLogSchema).optional(),
  mergedFrom: z.array(MergedSourceInfoSchema).optional(),
  updateHistory: z.array(UpdateHistoryEntrySchema).optional(),
  costs: z.array(StageCostSchema),
  totalCostUsd: z.number().nonnegative(),
  skillIndexTokens: z.number().int().nonnegative(),
});

export type GroundingMode = z.infer<typeof GroundingModeSchema>;
export type StageCost = z.infer<typeof StageCostSchema>;
export type DroppedPatternLog = z.infer<typeof DroppedPatternLogSchema>;
export type UpdateHistoryEntry = z.infer<typeof UpdateHistoryEntrySchema>;
export type MergedSourceInfo = z.infer<typeof MergedSourceInfoSchema>;
export type DistillReport = z.infer<typeof DistillReportSchema>;
