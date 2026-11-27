import { z } from "zod";
import { MaturityClassificationSchema } from "./repo-profile";

export const GitHubRepoSummarySchema = z.object({
  name: z.string(),
  full_name: z.string(),
  html_url: z.string(),
  clone_url: z.string(),
  language: z.string().nullable(),
  stargazers_count: z.number().int().nonnegative(),
  fork: z.boolean(),
  archived: z.boolean(),
  pushed_at: z.string().nullable().optional(),
  default_branch: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export const OrgScanRepoResultSchema = z.object({
  rank: z.number().int().nonnegative(),
  name: z.string(),
  fullName: z.string(),
  url: z.string(),
  stars: z.number().int().nonnegative(),
  primaryLanguage: z.string(),
  maturity: MaturityClassificationSchema,
  topSignalFiles: z.array(z.string()),
  signalDensityScore: z.number().nonnegative(),
  totalFilesScanned: z.number().int().nonnegative(),
  highSignalCommits: z.number().int().nonnegative(),
  bundleTokens: z.number().int().nonnegative(),
  estDistillCostUsd: z.number().nonnegative(),
  status: z.enum(["scanned", "skipped", "failed"]),
  error: z.string().optional(),
});

export const OrgScanReportSchema = z.object({
  version: z.literal("2.0"),
  org: z.string(),
  scannedAt: z.string(),
  filters: z.object({
    limit: z.number().int().positive(),
    lang: z.string().nullable(),
    minStars: z.number().int().nonnegative(),
    maxSizeMb: z.number().positive(),
    includeForks: z.boolean(),
    includeArchived: z.boolean(),
  }),
  authenticated: z.boolean(),
  totalCandidatesFound: z.number().int().nonnegative(),
  skippedOversizedRepos: z
    .array(
      z.object({
        name: z.string(),
        fullName: z.string(),
        sizeMb: z.number().nonnegative(),
      }),
    )
    .optional(),
  repos: z.array(OrgScanRepoResultSchema),
  topRecommendations: z.array(z.string()),
});

export type GitHubRepoSummary = z.infer<typeof GitHubRepoSummarySchema>;
export type OrgScanRepoResult = z.infer<typeof OrgScanRepoResultSchema>;
export type OrgScanReport = z.infer<typeof OrgScanReportSchema>;
