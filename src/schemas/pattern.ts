import { z } from "zod";

export const EvidenceCitationSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().positive().default(1),
  endLine: z.number().int().positive().default(1),
  commitSha: z.string().optional(),
  verbatimSnippet: z
    .string()
    .min(20)
    .max(2500)
    .describe("Exact code copied directly from the numbered source file without alteration."),
});

export const PatternCategorySchema = z.enum([
  "architecture",
  "concurrency",
  "memory_performance",
  "type_safety",
  "error_resilience",
  "state_management",
  "testing_verification",
  "api_boundary",
]);

export const CandidatePatternSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(8).max(90),
  category: PatternCategorySchema,
  maturityTag: z.enum(["production_proven", "experimental_technique"]),
  evidenceStatus: z.enum(["seen_explicit", "inferred_from_code"]),
  problemStatement: z
    .string()
    .min(40)
    .max(600)
    .describe("Concrete engineering problem solved by this pattern."),
  naiveApproach: z
    .string()
    .min(40)
    .max(600)
    .describe("The standard or default implementation an engineer or LLM writes first, and why it breaks under load or edge cases."),
  repoApproach: z
    .string()
    .min(60)
    .max(1200)
    .describe("The specific mechanism used in this repository, explaining data structures, invariants, and control flow."),
  tradeOffs: z.array(z.string().min(15)).min(2).max(5),
  whenToApply: z.array(z.string().min(15)).min(1).max(4),
  antiTriggers: z
    .array(z.string().min(15))
    .min(2)
    .max(5)
    .describe("Explicit conditions where applying this pattern causes over-engineering, bugs, or maintenance harm."),
  citations: z.array(EvidenceCitationSchema).min(1).max(3),
  transferableRule: z
    .string()
    .min(30)
    .max(300)
    .describe("One crisp, actionable decision rule a coding agent can follow in a different project."),
});

export const PatternMiningOutputSchema = z.object({
  repoDomainSummary: z.string().min(30).max(400),
  operatingConstraints: z
    .array(z.string().min(10))
    .min(1)
    .max(5)
    .describe("Hardware, scale, latency, or runtime constraints unique to this repo."),
  patterns: z.array(CandidatePatternSchema).min(1).max(12),
});

export type EvidenceCitation = z.infer<typeof EvidenceCitationSchema>;
export type PatternCategory = z.infer<typeof PatternCategorySchema>;
export type CandidatePattern = z.infer<typeof CandidatePatternSchema>;
export type PatternMiningOutput = z.infer<typeof PatternMiningOutputSchema>;
