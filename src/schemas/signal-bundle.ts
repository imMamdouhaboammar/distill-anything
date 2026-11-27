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

export type SignalFile = z.infer<typeof SignalFileSchema>;
export type SignalCommit = z.infer<typeof SignalCommitSchema>;
export type SignalBundle = z.infer<typeof SignalBundleSchema>;
