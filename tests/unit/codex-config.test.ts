import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs } from "../../src/cli/args";
import { resolveNonTtyDefaults } from "../../src/cli/setup";
import { BudgetLedger } from "../../src/core/budget";
import { CodexNotFoundError, discoverCodex, readCodexConfigToml } from "../../src/core/codex-discovery";
import { DistillConfigSchema, getConfigPath, loadConfig, saveConfig, type DistillConfig } from "../../src/core/config";
import { buildCodexExecArgs } from "../../src/core/llm";

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

    // Unit check for resolveNonTtyDefaults
    expect(resolveNonTtyDefaults()).toEqual({
      model: "default",
      reasoningEffort: "medium",
      judgeModel: "default",
      judgeReasoningEffort: "low",
    });

    process.env.DISTILL_MODEL = "codex:gpt-5.4";
    process.env.DISTILL_REASONING = "high";
    expect(resolveNonTtyDefaults()).toEqual({
      model: "gpt-5.4",
      reasoningEffort: "high",
      judgeModel: "gpt-5.4",
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
    for (const model of ["codex:gpt-5.4", "codex:gpt-5.3-codex", "codex:gpt-5.2-codex", "codex:o3"]) {
      const p = budget.getPricing(model);
      expect(p.inputPerMillionUsd).toBeGreaterThan(0);
      expect(p.outputPerMillionUsd).toBeGreaterThan(0);
    }
  });
});
