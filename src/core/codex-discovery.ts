import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export interface CodexDiscoveryResult {
  codexPath: string;
  version: string;
  tomlDefaultModel?: string;
  tomlReasoningEffort?: string;
}

function isExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads top-level `model` and `model_reasoning_effort` from `~/.codex/config.toml`
 * (read-only, optional). Never throws on missing or malformed files.
 */
export function readCodexConfigToml(
  tomlPath = join(homedir(), ".codex", "config.toml"),
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
  } catch {
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

export function discoverCodex(options?: { tomlPath?: string }): CodexDiscoveryResult {
  const codexPath = findCodexExecutable();
  if (!codexPath) {
    const override = process.env.DISTILL_CODEX_PATH?.trim();
    const detail = override
      ? `DISTILL_CODEX_PATH="${override}" does not exist or is not executable.`
      : `Could not find the "codex" CLI on PATH or in standard install directories.`;
    throw new CodexNotFoundError(
      `${detail}\n` +
        `Install & authenticate Codex CLI (e.g. \`npm i -g @openai/codex && codex login\`), ` +
        `set DISTILL_CODEX_PATH, or pass an explicit model from another provider ` +
        `(e.g. \`--model anthropic:claude-sonnet-4-5\` or \`--model openai:gpt-4.1\`).`,
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
        `Verify your Codex CLI installation or pass an explicit \`--model <provider>:<model>\`.`,
    );
  }

  const stdout = new TextDecoder().decode(probe.stdout);
  const version = parseCodexVersion(stdout) || "unknown";
  const toml = readCodexConfigToml(options?.tomlPath);

  return {
    codexPath,
    version,
    ...(toml.model ? { tomlDefaultModel: toml.model } : {}),
    ...(toml.reasoningEffort ? { tomlReasoningEffort: toml.reasoningEffort } : {}),
  };
}
