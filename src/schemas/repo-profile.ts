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

export type MaturityClassification = z.infer<typeof MaturityClassificationSchema>;
export type LanguageStat = z.infer<typeof LanguageStatSchema>;
export type RepoProfile = z.infer<typeof RepoProfileSchema>;
