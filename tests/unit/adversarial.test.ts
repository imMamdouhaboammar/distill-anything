import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRepository } from "../../src/stages/01-ingest";
import { buildSignalBundle } from "../../src/stages/02-signals/bundler";

let nonGitDir: string;
let oversizedDir: string;
let largeTokenDir: string;

beforeAll(() => {
  nonGitDir = mkdtempSync(join(tmpdir(), "distill-nogit-"));
  writeFileSync(join(nonGitDir, "index.ts"), "export const hello = (name: string) => `hi ${name}`;\n");

  oversizedDir = mkdtempSync(join(tmpdir(), "distill-oversized-"));
  writeFileSync(join(oversizedDir, "small.ts"), "export const ok = true;\n");
  // > 250 KB file
  writeFileSync(join(oversizedDir, "huge.ts"), `export const data = "${"a".repeat(260 * 1024)}";\n`);

  largeTokenDir = mkdtempSync(join(tmpdir(), "distill-60k-"));
  mkdirSync(join(largeTokenDir, "src"), { recursive: true });
  for (let i = 0; i < 30; i++) {
    const body = Array.from(
      { length: 220 },
      (_, j) => `export function fn_${i}_${j}(input: number): number { return (input * ${j + 1}) ^ ${i + 7}; }`,
    ).join("\n");
    writeFileSync(join(largeTokenDir, `src/mod${i}.ts`), body);
  }
});

afterAll(() => {
  rmSync(nonGitDir, { recursive: true, force: true });
  rmSync(oversizedDir, { recursive: true, force: true });
  rmSync(largeTokenDir, { recursive: true, force: true });
});

describe("Layer 2: Adversarial & Edge-Case Tests", () => {
  it("rejects --subpath ../../etc immediately (path traversal guard)", async () => {
    const proc = Bun.spawn(["bun", "run", "bin/distill-anything.ts", nonGitDir, "--subpath", "../../etc", "--dry-run"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(stderr).toContain("escapes repository root");
  });

  it("exits with code 3 when --max-budget 0.001 is exceeded before API call", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "bin/distill-anything.ts",
        largeTokenDir,
        "--max-budget",
        "0.001",
        "--model",
        "openai:gpt-4.1",
        "--judge-model",
        "openai:gpt-4.1-mini",
        "--no-git",
      ],
      {
        env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "sk-dummy-test-key" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(3);
    expect(stderr).toContain("Budget cap exceeded");
  });

  it("records files > 250KB in skippedOversizedFiles", async () => {
    const ingest = await ingestRepository({
      source: oversizedDir,
      subpath: ".",
      gitDepth: 10,
      noGit: true,
    });
    try {
      expect(ingest.profile.skippedOversizedFiles).toContain("huge.ts");
      expect(ingest.files.map((f) => f.relPath)).toEqual(["small.ts"]);
    } finally {
      ingest.cleanup();
    }
  });

  it("caps SignalBundle at <= 60,000 tokens on large repositories", async () => {
    const ingest = await ingestRepository({
      source: largeTokenDir,
      subpath: ".",
      gitDepth: 10,
      noGit: true,
    });
    try {
      const bundle = await buildSignalBundle({
        ingest,
        maxFiles: 40,
        maxCommits: 0,
        gitDepth: 10,
      });
      expect(bundle.totalTokens).toBeLessThanOrEqual(60_000);
      expect(bundle.files.length).toBeGreaterThan(0);
    } finally {
      ingest.cleanup();
    }
  });

  it("handles non-git local directory gracefully with and without --no-git", async () => {
    const withoutFlag = Bun.spawn(["bun", "run", "bin/distill-anything.ts", nonGitDir, "--dry-run", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code1 = await withoutFlag.exited;
    const stdout1 = await new Response(withoutFlag.stdout).text();
    const stderr1 = await new Response(withoutFlag.stderr).text();
    expect(code1).toBe(0);
    expect(stderr1).toContain("Git history unavailable");
    expect(JSON.parse(stdout1).profile.commitSha).toBeNull();

    const withFlag = Bun.spawn(["bun", "run", "bin/distill-anything.ts", nonGitDir, "--no-git", "--dry-run", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code2 = await withFlag.exited;
    const stdout2 = await new Response(withFlag.stdout).text();
    expect(code2).toBe(0);
    expect(JSON.parse(stdout2).profile.commitSha).toBeNull();
  });
});
