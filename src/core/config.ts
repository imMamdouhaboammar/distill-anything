import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const DistillConfigSchema = z.object({
  provider: z.literal("codex"),
  codexPath: z.string().min(1).optional(),
  model: z.string().min(1),
  reasoningEffort: ReasoningEffortSchema,
  judgeModel: z.string().min(1).optional(),
  judgeReasoningEffort: ReasoningEffortSchema.optional(),
  publishRepo: z.string().min(1).optional(),
  publishBranch: z.string().min(1).optional(),
  autoPublish: z.boolean().optional(),
  updatedAt: z.string().min(1),
});

export type DistillConfig = z.infer<typeof DistillConfigSchema>;

export function getConfigPath(): string {
  const override = process.env.DISTILL_CONFIG_PATH?.trim();
  if (override) return override;
  return join(homedir(), ".config", "distill-anything", "config.json");
}

export function loadConfig(configPath = getConfigPath()): DistillConfig | null {
  if (!existsSync(configPath)) return null;
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return DistillConfigSchema.parse(parsed);
}

export function saveConfig(config: DistillConfig, configPath = getConfigPath()): void {
  const validated = DistillConfigSchema.parse(config);
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  renameSync(tmpPath, configPath);
}
