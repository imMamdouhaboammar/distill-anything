import { createInterface } from "node:readline/promises";
import type { CodexDiscoveryResult } from "../core/codex-discovery";
import {
  ReasoningEffortSchema,
  saveConfig,
  type DistillConfig,
  type ReasoningEffort,
} from "../core/config";

export const CODEX_STANDARD_MODELS = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "o3",
] as const;

export const SUPPORTED_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

function normalizeModelChoice(raw: string): string {
  return raw.startsWith("codex:") ? raw.slice("codex:".length) : raw;
}

export function resolveNonTtyDefaults(): {
  model: string;
  reasoningEffort: ReasoningEffort;
  judgeModel: string;
  judgeReasoningEffort: ReasoningEffort;
} {
  const envModel = process.env.DISTILL_MODEL?.trim();
  const model = envModel ? normalizeModelChoice(envModel) : "default";

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

    // Build model menu, highlighting ~/.codex/config.toml default if present.
    const tomlDefault = discovery.tomlDefaultModel;
    const baseModels: string[] = [...CODEX_STANDARD_MODELS];
    if (tomlDefault && !baseModels.includes(tomlDefault)) {
      baseModels.unshift(tomlDefault);
    }

    const defaultModel = existingConfig?.model ?? tomlDefault ?? baseModels[0]!;
    console.error("\nSelect primary GPT model for Codex CLI:");
    baseModels.forEach((m, i) => {
      const tags: string[] = [];
      if (m === tomlDefault) tags.push("codex config.toml default");
      if (m === existingConfig?.model) tags.push("current");
      const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      console.error(`  ${i + 1}) ${m}${suffix}`);
    });
    const customIdx = baseModels.length + 1;
    console.error(`  ${customIdx}) Custom model ID`);

    const defaultIdx = Math.max(1, baseModels.indexOf(defaultModel) + 1);
    const modelAnswer = (await rl.question(`Choice [${defaultIdx}]: `)).trim();
    let selectedModel = defaultModel;
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

    // Reasoning effort selection
    const defaultReasoning: ReasoningEffort =
      existingConfig?.reasoningEffort ??
      (ReasoningEffortSchema.safeParse(discovery.tomlReasoningEffort).success
        ? (discovery.tomlReasoningEffort as ReasoningEffort)
        : "medium");

    console.error("\nSelect reasoning effort:");
    SUPPORTED_REASONING_EFFORTS.forEach((effort, i) => {
      const tag = effort === defaultReasoning ? " (default)" : "";
      console.error(`  ${i + 1}) ${effort}${tag}`);
    });
    const defaultEffortIdx = SUPPORTED_REASONING_EFFORTS.indexOf(defaultReasoning) + 1;
    const effortAnswer = (await rl.question(`Choice [${defaultEffortIdx}]: `)).trim();
    let reasoningEffort: ReasoningEffort = defaultReasoning;
    if (effortAnswer) {
      const num = Number.parseInt(effortAnswer, 10);
      if (num >= 1 && num <= SUPPORTED_REASONING_EFFORTS.length) {
        reasoningEffort = SUPPORTED_REASONING_EFFORTS[num - 1]!;
      } else if (ReasoningEffortSchema.safeParse(effortAnswer).success) {
        reasoningEffort = effortAnswer as ReasoningEffort;
      }
    }

    // Judge model & reasoning selection
    const sameJudgeAnswer = (
      await rl.question(
        `\nUse same model (${selectedModel}) with "low" reasoning for Novelty Gate judge? (recommended for speed/cost) [Y/n]: `,
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

      console.error("\nSelect judge reasoning effort:");
      SUPPORTED_REASONING_EFFORTS.forEach((effort, i) => {
        const tag = effort === "low" ? " (default)" : "";
        console.error(`  ${i + 1}) ${effort}${tag}`);
      });
      const judgeEffortAnswer = (await rl.question("Choice [1]: ")).trim();
      if (judgeEffortAnswer) {
        const num = Number.parseInt(judgeEffortAnswer, 10);
        if (num >= 1 && num <= SUPPORTED_REASONING_EFFORTS.length) {
          judgeReasoningEffort = SUPPORTED_REASONING_EFFORTS[num - 1]!;
        } else if (ReasoningEffortSchema.safeParse(judgeEffortAnswer).success) {
          judgeReasoningEffort = judgeEffortAnswer as ReasoningEffort;
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

    saveConfig(config, configPath);
    console.error(`[distill-anything] Saved configuration -> ${configPath ?? "~/.config/distill-anything/config.json"}\n`);
    return config;
  } finally {
    rl.close();
  }
}
