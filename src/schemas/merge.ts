import { z } from "zod";
import { MaturityTagSchema, PatternCategorySchema } from "./pattern";
import { DistillReportSchema } from "./report";

export const LoadedCitationSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  commitSha: z.string().min(1).optional(),
  verbatimSnippet: z.string().min(1),
  fenceLang: z.string().default("text"),
});

export const LoadedSkillPatternSchema = z.object({
  sourceSkillId: z.string().min(1),
  sourceRepoName: z.string().min(1),
  sourceUrl: z.string().min(1),
  sourceCommitSha: z.string().min(1),
  patternId: z.string().min(1),
  title: z.string().min(1),
  category: PatternCategorySchema,
  maturityTag: MaturityTagSchema,
  evidenceStatus: z.enum(["seen_explicit", "inferred_from_code"]),
  noveltyScore: z.number().int().min(1).max(5),
  transferabilityScore: z.number().int().min(1).max(5),
  problemStatement: z.string().min(1),
  naiveApproach: z.string().min(1),
  repoApproach: z.string().min(1),
  transferableRule: z.string().min(1),
  tradeOffs: z.array(z.string()).min(1),
  whenToApply: z.array(z.string()).min(1),
  antiTriggers: z.array(z.string()).min(1),
  citations: z.array(LoadedCitationSchema).min(1),
});

export const LoadedSkillSchema = z.object({
  skillDir: z.string().min(1),
  report: DistillReportSchema,
  patterns: z.array(LoadedSkillPatternSchema).min(1),
});

export const SnippetRefSchema = z.object({
  sourceSkillId: z.string().min(1),
  patternId: z.string().min(1),
  citationIndex: z.number().int().nonnegative(),
});

export const ConflictBranchSchema = z.object({
  sourceRepo: z.string().min(1),
  whenThisWins: z.string().min(1),
  approach: z.string().min(1),
  snippetRef: SnippetRefSchema,
});

export const MergedPatternPlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Pattern ID must be kebab-case"),
  title: z.string().min(1),
  category: PatternCategorySchema,
  maturityTag: MaturityTagSchema,
  noveltyScore: z.number().int().min(1).max(5),
  transferabilityScore: z.number().int().min(1).max(5),
  consensusCount: z.number().int().min(1),
  problemStatement: z.string().min(1),
  naiveApproach: z.string().min(1),
  repoApproach: z.string().min(1),
  transferableRule: z.string().min(1),
  tradeOffs: z.array(z.string()).min(1),
  whenToApply: z.array(z.string()).min(1),
  antiTriggers: z.array(z.string()).min(1),
  snippetRefs: z.array(SnippetRefSchema).min(1),
  conflictBranches: z.array(ConflictBranchSchema).optional(),
});

export const MergeSynthesisOutputSchema = z.object({
  operatingConstraints: z.array(z.string()).min(1),
  mergedPatterns: z.array(MergedPatternPlanSchema).min(1),
  droppedPatterns: z
    .array(
      z.object({
        sourceSkillId: z.string(),
        patternId: z.string(),
        title: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
});

export type LoadedCitation = z.infer<typeof LoadedCitationSchema>;
export type LoadedSkillPattern = z.infer<typeof LoadedSkillPatternSchema>;
export type LoadedSkill = z.infer<typeof LoadedSkillSchema>;
export type SnippetRef = z.infer<typeof SnippetRefSchema>;
export type ConflictBranch = z.infer<typeof ConflictBranchSchema>;
export type MergedPatternPlan = z.infer<typeof MergedPatternPlanSchema>;
export type MergeSynthesisOutput = z.infer<typeof MergeSynthesisOutputSchema>;
