# 03 — Data Schemas & LLM Contracts (`src/schemas/`)

All inter-stage data structures are strictly typed with Zod. LLM responses MUST use provider-native Structured Outputs (`generateObject` in Vercel AI SDK) bound directly to these schemas.

## 1. `src/schemas/repo-profile.ts`

```typescript
import { z } from "zod";

export const MaturityClassificationSchema = z.enum([
  "production",
  "hybrid",
  "research_prototype",
]);

export const LanguageStatSchema = z.object({
  language: z.string(),
  fileCount: z.number().int().nonnegative(),
  loc: z.number().int().nonnegative(),
  sharePercent: z.number().min(0).max(100),
});

export const RepoProfileSchema = z.object({
  source: z.string(),
  repoName: z.string(),
  skillSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  commitSha: z.string().nullable(),
  subpath: z.string(),
  analyzedAt: z.string().datetime(),
  primaryLanguage: z.string(),
  languages: z.array(LanguageStatSchema).min(1),
  totalFilesScanned: z.number().int().nonnegative(),
  skippedOversizedFiles: z.array(z.string()),
  maturity: z.object({
    classification: MaturityClassificationSchema,
    hasCiWorkflows: z.boolean(),
    hasBenchmarks: z.boolean(),
    hasStrictTyping: z.boolean(),
    testToSourceRatio: z.number().nonnegative(),
    experimentalMarkersPerKloc: z.number().nonnegative(),
  }),
});

export type RepoProfile = z.infer<typeof RepoProfileSchema>;
```

## 2. `src/schemas/signal-bundle.ts`

```typescript
import { z } from "zod";
import { RepoProfileSchema } from "./repo-profile";

export const SignalFileSchema = z.object({
  path: z.string(),
  bucket: z.enum(["core_architecture", "edge_case_test", "architecture_doc"]),
  language: z.string(),
  score: z.number(),
  fanIn: z.number().int().nonnegative(),
  tokenCount: z.number().int().positive(),
  truncated: z.boolean(),
  numberedContent: z.string(),
});

export const SignalCommitSchema = z.object({
  sha: z.string(),
  date: z.string(),
  subject: z.string(),
  body: z.string(),
  score: z.number(),
  tokenCount: z.number().int().positive(),
  diff: z.string(),
});

export const SignalBundleSchema = z.object({
  profile: RepoProfileSchema,
  totalTokens: z.number().int().nonnegative(),
  files: z.array(SignalFileSchema),
  commits: z.array(SignalCommitSchema),
});

export type SignalBundle = z.infer<typeof SignalBundleSchema>;
```

## 3. `src/schemas/pattern.ts`

```typescript
import { z } from "zod";

export const EvidenceCitationSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
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
export type CandidatePattern = z.infer<typeof CandidatePatternSchema>;
export type PatternMiningOutput = z.infer<typeof PatternMiningOutputSchema>;
```

## 4. `src/schemas/novelty.ts`

```typescript
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
  reasoning: z.string().min(30).max(500),
});

export const VerifiedPatternSchema = z.object({
  pattern: CandidatePatternSchema,
  groundingVerified: z.boolean(),
  blindBaselineSummary: z.string(),
  audit: NoveltyJudgeOutputSchema,
});

export type NoveltyJudgeOutput = z.infer<typeof NoveltyJudgeOutputSchema>;
export type VerifiedPattern = z.infer<typeof VerifiedPatternSchema>;
```

## 5. `src/schemas/report.ts`

```typescript
import { z } from "zod";
import { RepoProfileSchema } from "./repo-profile";

export const StageCostSchema = z.object({
  stage: z.enum(["miner", "novelty_baseline", "novelty_judge"]),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export const DroppedPatternLogSchema = z.object({
  patternId: z.string(),
  title: z.string(),
  stage: z.enum(["grounder", "novelty_gate"]),
  reason: z.string(),
  noveltyScore: z.number().int().min(1).max(5).optional(),
});

export const DistillReportSchema = z.object({
  version: z.literal("1.0"),
  profile: RepoProfileSchema,
  outputPath: z.string(),
  totalCandidatesExtracted: z.number().int().nonnegative(),
  groundingFailures: z.number().int().nonnegative(),
  patternsKept: z.number().int().nonnegative(),
  patternsDropped: z.array(DroppedPatternLogSchema),
  costs: z.array(StageCostSchema),
  totalCostUsd: z.number().nonnegative(),
  skillIndexTokens: z.number().int().nonnegative(),
});

export type DistillReport = z.infer<typeof DistillReportSchema>;
```

## 6. Budget Guardrail Contract (`src/core/budget.ts`)

* Maintain a pricing table per 1M input/output tokens for supported models (overridable via `DISTILL_PRICING_JSON`).
* Before EVERY LLM call, compute `estimatedCost = estimateTokens(prompt) * inputRate + maxOutputTokens * outputRate`.
* If `spentUsd + estimatedCost > maxBudgetUsd`, abort the call cleanly, emit partial diagnostics, and exit with code `3`.
* After every call, reconcile with exact `usage.promptTokens` and `usage.completionTokens` returned by the provider.
