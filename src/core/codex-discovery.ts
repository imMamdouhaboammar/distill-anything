import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const CodexModelEntrySchema = z
  .object({
    visibility: z.string().optional(),
    slug: z.string().optional(),
    display_name: z.string().optional(),
    priority: z.number().finite().optional(),
    default_reasoning_level: z.string().optional(),
    supported_reasoning_levels: z
      .array(z.object({ effort: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

const CodexModelsCacheSchema = z
  .object({
    models: z.array(CodexModelEntrySchema).optional(),
  })
  .passthrough();

export class CodexNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexNotFoundError";
  }
}

export interface CodexTomlDefaults {
  model?: string;
  reasoningEffort?: string;
}

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  priority: number;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: string[];
}

export interface CodexDiscoveryResult {
  codexPath: string;
  version: string;
  tomlDefaultModel?: string;
  tomlReasoningEffort?: string;
  availableModels: CodexModelInfo[];
  flagshipModel?: string;
}

function isExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch (err) {
    // SAFETY: accessSync throws an ErrnoException when the binary is missing or not executable.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR") {
      return false;
    }
    return false;
  }
}

function getCodexHomeDir(): string {
  const override = process.env.CODEX_HOME?.trim();
  return override || join(homedir(), ".codex");
}

/**
 * Reads visible models from `~/.codex/models_cache.json` sorted by priority
 * ascending (priority 1 = latest flagship). Never throws on missing/malformed files.
 */
export function readCodexModelsCache(
  cachePath = join(getCodexHomeDir(), "models_cache.json"),
): CodexModelInfo[] {
  try {
    if (!existsSync(cachePath)) return [];
    const raw = readFileSync(cachePath, "utf8");
    const parsed = CodexModelsCacheSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !parsed.data.models) return [];

    const models: CodexModelInfo[] = [];
    for (const m of parsed.data.models) {
      if (m.visibility !== "list") continue;
      const slug = m.slug?.trim();
      if (!slug) continue;

      const displayName = m.display_name?.trim() || slug;
      const priority = m.priority ?? Number.MAX_SAFE_INTEGER;
      const defaultReasoningLevel = m.default_reasoning_level?.trim() || undefined;

      const supportedReasoningLevels: string[] = [];
      for (const lvl of m.supported_reasoning_levels ?? []) {
        const effort = lvl.effort?.trim();
        if (effort) supportedReasoningLevels.push(effort);
      }

      const modelInfo: CodexModelInfo = {
        slug,
        displayName,
        priority,
        supportedReasoningLevels,
      };
      if (defaultReasoningLevel) {
        modelInfo.defaultReasoningLevel = defaultReasoningLevel;
      }
      models.push(modelInfo);
    }

    models.sort((a, b) => a.priority - b.priority);
    return models;
  } catch (err) {
    if (process.env.DISTILL_DEBUG) {
      console.warn(`[codex-discovery] Failed to read models cache: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
}

/**
 * Reads top-level `model` and `model_reasoning_effort` from `~/.codex/config.toml`
 * (read-only, optional). Never throws on missing or malformed files.
 */
export function readCodexConfigToml(
  tomlPath = join(getCodexHomeDir(), "config.toml"),
): CodexTomlDefaults {
  try {
    if (!existsSync(tomlPath)) return {};
    const raw = readFileSync(tomlPath, "utf8");
    const result: CodexTomlDefaults = {};

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      // Stop at the first TOML [table] header so we only read top-level defaults.
      if (line.startsWith("[")) break;

      const modelMatch = line.match(/^model\s*=\s*["']([^"']+)["']$/);
      if (modelMatch?.[1]) {
        result.model = modelMatch[1].trim();
        continue;
      }

      const effortMatch = line.match(/^model_reasoning_effort\s*=\s*["']([^"']+)["']$/);
      if (effortMatch?.[1]) {
        result.reasoningEffort = effortMatch[1].trim();
      }
    }

    return result;
  } catch (err) {
    if (process.env.DISTILL_DEBUG) {
      console.warn(`[codex-discovery] Failed to read config.toml: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  }
}

export function findCodexExecutable(): string | null {
  const override = process.env.DISTILL_CODEX_PATH?.trim();
  if (override) {
    return isExecutable(override) ? override : null;
  }

  const onPath = Bun.which("codex");
  if (onPath && isExecutable(onPath)) {
    return onPath;
  }

  const home = homedir();
  const fallbacks = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(home, ".local", "bin", "codex"),
    join(home, ".npm-global", "bin", "codex"),
    join(home, ".bun", "bin", "codex"),
  ];

  for (const candidate of fallbacks) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function parseCodexVersion(rawStdout: string): string {
  const trimmed = rawStdout.trim();
  const match = trimmed.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return match?.[1] ?? trimmed;
}

export function discoverCodex(options?: {
  tomlPath?: string;
  modelsCachePath?: string;
}): CodexDiscoveryResult {
  const codexPath = findCodexExecutable();
  if (!codexPath) {
    const override = process.env.DISTILL_CODEX_PATH?.trim();
    const detail = override
      ? `DISTILL_CODEX_PATH="${override}" does not exist or is not executable.`
      : `Could not find the "codex" CLI on PATH or in standard install directories.`;
    throw new CodexNotFoundError(
      `${detail}\n` +
        `distill-anything uses Codex CLI exclusively. Install & authenticate Codex CLI ` +
        `(e.g. \`bun add -g @openai/codex && codex login\`) or set DISTILL_CODEX_PATH.`,
    );
  }

  const probe = Bun.spawnSync([codexPath, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (probe.exitCode !== 0) {
    const stderr = new TextDecoder().decode(probe.stderr).trim();
    throw new CodexNotFoundError(
      `Found codex at "${codexPath}" but \`codex --version\` exited with code ${probe.exitCode}` +
        `${stderr ? `: ${stderr}` : "."}\n` +
        `Verify your Codex CLI installation.`,
    );
  }

  const stdout = new TextDecoder().decode(probe.stdout);
  const version = parseCodexVersion(stdout) || "unknown";
  const toml = readCodexConfigToml(options?.tomlPath);
  const availableModels = readCodexModelsCache(options?.modelsCachePath);
  const flagshipModel = availableModels[0]?.slug;

  const result: CodexDiscoveryResult = {
    codexPath,
    version,
    availableModels,
  };
  if (toml.model) result.tomlDefaultModel = toml.model;
  if (toml.reasoningEffort) result.tomlReasoningEffort = toml.reasoningEffort;
  if (flagshipModel) result.flagshipModel = flagshipModel;
  return result;
}
