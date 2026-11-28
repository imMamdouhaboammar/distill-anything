import { createInterface } from "node:readline/promises";
import type { CodexDiscoveryResult, CodexModelInfo } from "../core/codex-discovery";
import {
  ReasoningEffortSchema,
  saveConfig,
  type DistillConfig,
  type ReasoningEffort,
} from "../core/config";

export const CODEX_STANDARD_MODELS = [
  "gpt-6.2-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
  "gpt-6.2-astra",
  "gpt-6.1-sol",
  "gpt-5.4",
] as const;

export const SUPPORTED_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function normalizeModelChoice(raw: string): string {
  return raw.startsWith("codex:") ? raw.slice("codex:".length) : raw;
}

export function resolveLatestFlagshipModel(discovery?: {
  flagshipModel?: string | undefined;
  availableModels: CodexModelInfo[];
}): string {
  return discovery?.flagshipModel ?? discovery?.availableModels[0]?.slug ?? CODEX_STANDARD_MODELS[0];
}

function getEffortsForModel(modelSlug: string, availableModels: CodexModelInfo[]): readonly ReasoningEffort[] {
  const info = availableModels.find((m) => m.slug === modelSlug);
  if (!info || info.supportedReasoningLevels.length === 0) {
    return SUPPORTED_REASONING_EFFORTS;
  }
  const filtered = SUPPORTED_REASONING_EFFORTS.filter((e) => info.supportedReasoningLevels.includes(e));
  return filtered.length > 0 ? filtered : SUPPORTED_REASONING_EFFORTS;
}

export function resolveNonTtyDefaults(
  discovery?: {
    flagshipModel?: string | undefined;
    availableModels: CodexModelInfo[];
  },
): {
  model: string;
  reasoningEffort: ReasoningEffort;
  judgeModel: string;
  judgeReasoningEffort: ReasoningEffort;
} {
  const envModel = process.env.DISTILL_MODEL?.trim();
  const model = envModel ? normalizeModelChoice(envModel) : resolveLatestFlagshipModel(discovery);

  const envReasoning = process.env.DISTILL_REASONING?.trim();
  const parsedReasoning = ReasoningEffortSchema.safeParse(envReasoning);
  const reasoningEffort: ReasoningEffort = parsedReasoning.success ? parsedReasoning.data : "medium";

  return {
    model,
    reasoningEffort,
    judgeModel: model,
    judgeReasoningEffort: "low",
  };
}

export async function runInteractiveSetup(
  discovery: CodexDiscoveryResult,
  existingConfig?: DistillConfig | null,
  configPath?: string,
): Promise<DistillConfig> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    console.error(`\n[distill-anything] Codex CLI detected: ${discovery.codexPath} (v${discovery.version})`);

    const flagshipModel = resolveLatestFlagshipModel(discovery);
    const flagshipInfo = discovery.availableModels.find((m) => m.slug === flagshipModel);
    const parsedTomlEffort = ReasoningEffortSchema.safeParse(discovery.tomlReasoningEffort);
    const parsedFlagshipEffort = ReasoningEffortSchema.safeParse(flagshipInfo?.defaultReasoningLevel);
    const defaultReasoning: ReasoningEffort =
      existingConfig?.reasoningEffort ??
      (parsedTomlEffort.success
        ? parsedTomlEffort.data
        : parsedFlagshipEffort.success
          ? parsedFlagshipEffort.data
          : "medium");

    const permissionAnswer = (
      await rl.question(
        `\nUse latest Codex CLI flagship model "${flagshipModel}" with "${defaultReasoning}" thinking effort by default? [Y/n]: `,
      )
    )
      .trim()
      .toLowerCase();

    let selectedModel = flagshipModel;
    let reasoningEffort: ReasoningEffort = defaultReasoning;

    if (permissionAnswer === "n" || permissionAnswer === "no") {
      // Build model menu prioritizing the flagship trio (gpt-6.2-sol, gpt-6.1-terra, gpt-6-luna),
      // then remaining models from Codex models_cache.json, highlighting config.toml default if present.
      const tomlDefault = discovery.tomlDefaultModel;
      const discoveredSlugs = discovery.availableModels.map((m) => m.slug);
      const baseModels: string[] = [];
      for (const slug of [...CODEX_STANDARD_MODELS.slice(0, 3), ...discoveredSlugs, ...CODEX_STANDARD_MODELS.slice(3)]) {
        if (!baseModels.includes(slug)) {
          baseModels.push(slug);
        }
      }
      if (tomlDefault && !baseModels.includes(tomlDefault)) {
        baseModels.unshift(tomlDefault);
      }

      const defaultModel = existingConfig?.model ?? tomlDefault ?? baseModels[0]!;
      console.error("\nSelect Codex CLI model:");
      baseModels.forEach((m, i) => {
        const tags: string[] = [];
        if (m === flagshipModel) tags.push("latest flagship");
        if (m === tomlDefault) tags.push("codex config.toml default");
        if (m === existingConfig?.model) tags.push("current");
        const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        console.error(`  ${i + 1}) ${m}${suffix}`);
      });
      const customIdx = baseModels.length + 1;
      console.error(`  ${customIdx}) Custom model ID`);

      const defaultIdx = Math.max(1, baseModels.indexOf(defaultModel) + 1);
      const modelAnswer = (await rl.question(`Choice [${defaultIdx}]: `)).trim();
      selectedModel = defaultModel;
      if (modelAnswer) {
        const num = Number.parseInt(modelAnswer, 10);
        if (num === customIdx) {
          const custom = (await rl.question("Enter custom Codex model ID: ")).trim();
          if (custom) selectedModel = normalizeModelChoice(custom);
        } else if (num >= 1 && num <= baseModels.length) {
          selectedModel = baseModels[num - 1]!;
        } else {
          selectedModel = normalizeModelChoice(modelAnswer);
        }
      }

      // Thinking effort selection for the chosen model
      const allowedEfforts = getEffortsForModel(selectedModel, discovery.availableModels);
      const fallbackEffort: ReasoningEffort = allowedEfforts.includes(defaultReasoning)
        ? defaultReasoning
        : allowedEfforts[0]!;

      console.error(`\nSelect thinking effort for ${selectedModel}:`);
      allowedEfforts.forEach((effort, i) => {
        const tag = effort === fallbackEffort ? " (default)" : "";
        console.error(`  ${i + 1}) ${effort}${tag}`);
      });
      const defaultEffortIdx = allowedEfforts.indexOf(fallbackEffort) + 1;
      const effortAnswer = (await rl.question(`Choice [${defaultEffortIdx}]: `)).trim();
      reasoningEffort = fallbackEffort;
      if (effortAnswer) {
        const num = Number.parseInt(effortAnswer, 10);
        if (num >= 1 && num <= allowedEfforts.length) {
          reasoningEffort = allowedEfforts[num - 1]!;
        } else {
          const parsedEffort = ReasoningEffortSchema.safeParse(effortAnswer);
          if (parsedEffort.success) reasoningEffort = parsedEffort.data;
        }
      }
    }

    // Judge model & thinking effort selection
    const sameJudgeAnswer = (
      await rl.question(
        `\nUse same model (${selectedModel}) with "low" thinking effort for Novelty Gate judge? (recommended for speed/cost) [Y/n]: `,
      )
    )
      .trim()
      .toLowerCase();

    let judgeModel = selectedModel;
    let judgeReasoningEffort: ReasoningEffort = "low";

    if (sameJudgeAnswer === "n" || sameJudgeAnswer === "no") {
      const customJudge = (
        await rl.question(`Enter judge model ID [${existingConfig?.judgeModel ?? selectedModel}]: `)
      ).trim();
      if (customJudge) {
        judgeModel = normalizeModelChoice(customJudge);
      } else if (existingConfig?.judgeModel) {
        judgeModel = existingConfig.judgeModel;
      }

      const judgeAllowedEfforts = getEffortsForModel(judgeModel, discovery.availableModels);
      console.error(`\nSelect judge thinking effort for ${judgeModel}:`);
      judgeAllowedEfforts.forEach((effort, i) => {
        const tag = effort === "low" ? " (default)" : "";
        console.error(`  ${i + 1}) ${effort}${tag}`);
      });
      const judgeEffortAnswer = (await rl.question("Choice [1]: ")).trim();
      if (judgeEffortAnswer) {
        const num = Number.parseInt(judgeEffortAnswer, 10);
        if (num >= 1 && num <= judgeAllowedEfforts.length) {
          judgeReasoningEffort = judgeAllowedEfforts[num - 1]!;
        } else {
          const parsedJudgeEffort = ReasoningEffortSchema.safeParse(judgeEffortAnswer);
          if (parsedJudgeEffort.success) judgeReasoningEffort = parsedJudgeEffort.data;
        }
      }
    }

    const config: DistillConfig = {
      provider: "codex",
      codexPath: discovery.codexPath,
      model: selectedModel,
      reasoningEffort,
      judgeModel,
      judgeReasoningEffort,
      updatedAt: new Date().toISOString(),
    };
    if (existingConfig?.publishRepo) config.publishRepo = existingConfig.publishRepo;
    if (existingConfig?.publishBranch) config.publishBranch = existingConfig.publishBranch;
    if (existingConfig?.autoPublish !== undefined) config.autoPublish = existingConfig.autoPublish;

    saveConfig(config, configPath);
    console.error(`[distill-anything] Saved configuration -> ${configPath ?? "~/.config/distill-anything/config.json"}\n`);
    return config;
  } finally {
    rl.close();
  }
}
