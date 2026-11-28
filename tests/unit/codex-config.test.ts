import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs } from "../../src/cli/args";
import { CODEX_STANDARD_MODELS, resolveLatestFlagshipModel, resolveNonTtyDefaults } from "../../src/cli/setup";
import { BudgetLedger } from "../../src/core/budget";
import {
  CodexNotFoundError,
  discoverCodex,
  readCodexConfigToml,
  readCodexModelsCache,
} from "../../src/core/codex-discovery";
import { DistillConfigSchema, getConfigPath, loadConfig, saveConfig, type DistillConfig } from "../../src/core/config";
import { InvalidModelError, buildCodexExecArgs, parseModelId, validateApiKeys } from "../../src/core/llm";

const tempDirs: string[] = [];

function makeTempDir(prefix = "distill-anything-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.DISTILL_CONFIG_PATH;
  delete process.env.DISTILL_CODEX_PATH;
  delete process.env.DISTILL_MODEL;
  delete process.env.DISTILL_REASONING;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Codex config, discovery, and CLI wiring", () => {
  it("validates, atomically saves, and loads config via DISTILL_CONFIG_PATH without mutating on per-run overrides", () => {
    const dir = makeTempDir();
    const cfgPath = join(dir, "nested", "config.json");
    process.env.DISTILL_CONFIG_PATH = cfgPath;

    expect(getConfigPath()).toBe(cfgPath);
    expect(loadConfig()).toBeNull();

    const sample: DistillConfig = {
      provider: "codex",
      codexPath: "/usr/local/bin/codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
      judgeModel: "gpt-5.3-codex",
      judgeReasoningEffort: "low",
      updatedAt: "2026-11-27T00:00:00.000Z",
    };

    saveConfig(sample);
    const loaded = loadConfig();
    expect(loaded).toEqual(sample);

    // Invalid config fails Zod validation
    expect(() =>
      DistillConfigSchema.parse({
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "turbo",
        updatedAt: "2026-11-27T00:00:00.000Z",
      }),
    ).toThrow();

    // Per-run CLI overrides parse cleanly and do not mutate saved config
    const opts = parseCliArgs([
      "bun",
      "distill-anything",
      ".",
      "--model",
      "codex:o3",
      "--reasoning",
      "low",
      "--judge-reasoning",
      "medium",
    ]);
    expect(opts.mode).toBe("repo");
    if (opts.mode === "repo") {
      expect(opts.model).toBe("codex:o3");
      expect(opts.modelExplicit).toBe(true);
      expect(opts.reasoning).toBe("low");
      expect(opts.judgeReasoning).toBe("medium");
    }
    expect(loadConfig()).toEqual(sample);
    expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toEqual(sample);
  });

  it("reads top-level defaults from codex config.toml safely", () => {
    const dir = makeTempDir();
    const tomlPath = join(dir, "config.toml");
    writeFileSync(
      tomlPath,
      `# comment\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "high"\n\n[projects."/tmp"]\nmodel = "ignored"\n`,
      "utf8",
    );
    expect(readCodexConfigToml(tomlPath)).toEqual({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(readCodexConfigToml(join(dir, "missing.toml"))).toEqual({});
  });

  it("fails cleanly with exit code 2 when DISTILL_CODEX_PATH points to a missing binary", () => {
    const dir = makeTempDir();
    const missingBin = join(dir, "does-not-exist-codex");
    process.env.DISTILL_CODEX_PATH = missingBin;

    expect(() => discoverCodex()).toThrow(CodexNotFoundError);

    const proc = Bun.spawnSync(
      ["bun", "run", resolve("bin/distill-anything.ts"), ".", "--max-budget", "1.00"],
      {
        env: {
          ...process.env,
          DISTILL_CODEX_PATH: missingBin,
          DISTILL_CONFIG_PATH: join(dir, "config.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("DISTILL_CODEX_PATH");
  });

  it("uses non-TTY fallback defaults without hanging on stdin when no config exists", () => {
    const dir = makeTempDir();
    const fakeCodex = join(dir, "codex");
    writeFileSync(fakeCodex, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"codex-cli 0.166.0\"; exit 0; fi\nexit 1\n", { mode: 0o755 });

    // Unit check for resolveNonTtyDefaults (defaults to latest flagship model)
    expect(resolveNonTtyDefaults()).toEqual({
      model: CODEX_STANDARD_MODELS[0],
      reasoningEffort: "medium",
      judgeModel: CODEX_STANDARD_MODELS[0],
      judgeReasoningEffort: "low",
    });

    expect(
      resolveNonTtyDefaults({
        flagshipModel: "gpt-6.2-sol",
        availableModels: [],
      }),
    ).toEqual({
      model: "gpt-6.2-sol",
      reasoningEffort: "medium",
      judgeModel: "gpt-6.2-sol",
      judgeReasoningEffort: "low",
    });

    process.env.DISTILL_MODEL = "codex:gpt-6.2-astra";
    process.env.DISTILL_REASONING = "ultra";
    expect(resolveNonTtyDefaults()).toEqual({
      model: "gpt-6.2-astra",
      reasoningEffort: "ultra",
      judgeModel: "gpt-6.2-astra",
      judgeReasoningEffort: "low",
    });

    // Subprocess non-TTY test: closed stdin, no config file, should not hang and should log notice before failing on fake codex exec
    const proc = Bun.spawnSync(
      ["bun", "run", resolve("bin/distill-anything.ts"), "from-findings", resolve("README.md"), "--allow-ungrounded", "--skip-novelty"],
      {
        stdin: "ignore",
        env: {
          ...process.env,
          DISTILL_CODEX_PATH: fakeCodex,
          DISTILL_CONFIG_PATH: join(dir, "no-config.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("No config file found and non-interactive mode detected");
  });

  it("assembles codex exec CLI args with model, reasoning effort, and schema flags", () => {
    const args = buildCodexExecArgs({
      modelName: "gpt-5.4",
      reasoningEffort: "high",
      outPath: "/tmp/out.txt",
      schemaPath: "/tmp/schema.json",
      cdDir: "/tmp/work",
    });
    expect(args).toEqual([
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/work",
      "--json",
      "-o",
      "/tmp/out.txt",
      "-m",
      "gpt-5.4",
      "-c",
      "model_reasoning_effort=high",
      "--output-schema",
      "/tmp/schema.json",
      "-",
    ]);

    const defaultArgs = buildCodexExecArgs({
      modelName: "default",
      reasoningEffort: "medium",
      outPath: "/tmp/out.txt",
      cdDir: "/tmp/work",
    });
    expect(defaultArgs).not.toContain("-m");
    expect(defaultArgs).toContain("-c");
    expect(defaultArgs).toContain("model_reasoning_effort=medium");
    expect(defaultArgs).not.toContain("--output-schema");
  });

  it("prices Codex GPT models accurately without falling back to zero", () => {
    const budget = new BudgetLedger(10);
    for (const model of [
      "codex:gpt-6.2-sol",
      "codex:gpt-6.2-astra",
      "codex:gpt-6.1-terra",
      "codex:gpt-5.4",
      "codex:gpt-5.3-codex",
      "codex:o3",
    ]) {
      const p = budget.getPricing(model);
      expect(p.inputPerMillionUsd).toBeGreaterThan(0);
      expect(p.outputPerMillionUsd).toBeGreaterThan(0);
    }
  });

  it("discovers visible flagship models sorted by priority from models_cache.json", () => {
    const dir = makeTempDir();
    const cachePath = join(dir, "models_cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", priority: 0 },
          {
            slug: "gpt-6.2-astra",
            display_name: "GPT-6.2-Astra",
            visibility: "list",
            priority: 2,
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
          },
          {
            slug: "gpt-6.2-sol",
            display_name: "GPT-6.2-Sol",
            visibility: "list",
            priority: 1,
            default_reasoning_level: "high",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "ultra" }],
          },
        ],
      }),
      "utf8",
    );

    const models = readCodexModelsCache(cachePath);
    expect(models.map((m) => m.slug)).toEqual(["gpt-6.2-sol", "gpt-6.2-astra"]);
    expect(models[0]?.supportedReasoningLevels).toEqual(["low", "medium", "high", "ultra"]);
    expect(resolveLatestFlagshipModel({ flagshipModel: models[0]?.slug, availableModels: models })).toBe("gpt-6.2-sol");
  });

  it("enforces Codex CLI only and rejects external API providers", () => {
    expect(parseModelId("codex:gpt-6.2-sol")).toEqual({ provider: "codex", modelName: "gpt-6.2-sol" });
    for (const apiModel of [
      "openai:gpt-4.1",
      "anthropic:claude-sonnet-4-5",
      "google:gemini-2.5-flash",
      "gcloud:gemini-2.5-pro",
      "gpt-6.2-sol",
    ]) {
      expect(() => parseModelId(apiModel)).toThrow(InvalidModelError);
      expect(() => validateApiKeys([apiModel])).toThrow(InvalidModelError);
    }
  });
});
