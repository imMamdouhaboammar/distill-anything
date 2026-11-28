import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { BudgetLedger } from "./budget";
import { findCodexExecutable } from "./codex-discovery";
import type { ReasoningEffort } from "./config";
import type { StageCost } from "../schemas/report";

export class MissingApiKeyError extends Error {
  constructor(
    public readonly provider: string,
    public readonly envVar: string,
  ) {
    super(`Missing runtime for provider "${provider}". Ensure ${envVar} is available.`);
    this.name = "MissingApiKeyError";
  }
}

export class InvalidModelError extends Error {
  constructor(modelId: string) {
    super(
      `Invalid model specifier "${modelId}". distill-anything uses Codex CLI exclusively; expected "codex:<model>" (e.g. "codex:gpt-6.2-sol").`,
    );
    this.name = "InvalidModelError";
  }
}

export function parseModelId(modelId: string): { provider: "codex"; modelName: string } {
  const idx = modelId.indexOf(":");
  if (idx <= 0 || idx === modelId.length - 1) {
    throw new InvalidModelError(modelId);
  }
  const provider = modelId.slice(0, idx);
  if (provider !== "codex") {
    throw new InvalidModelError(modelId);
  }
  return {
    provider: "codex",
    modelName: modelId.slice(idx + 1),
  };
}

export function validateApiKeys(modelIds: string[]): void {
  for (const id of modelIds) {
    parseModelId(id);
    if (!findCodexExecutable()) {
      throw new MissingApiKeyError("codex", "codex CLI in PATH or DISTILL_CODEX_PATH");
    }
  }
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("timeout") ||
    msg.includes("overloaded")
  );
}

async function withExponentialBackoff<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1 || !isRetryableError(err)) {
        throw err;
      }
      const baseMs = 500 * 2 ** attempt;
      const jitterMs = Math.floor(Math.random() * baseMs);
      await Bun.sleep(baseMs + jitterMs);
    }
  }
  throw lastErr;
}

const JsonRecordSchema = z.record(z.string(), z.unknown());

function sanitizeSchemaForCodex(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForCodex);
  const parsedObj = JsonRecordSchema.safeParse(node);
  if (!parsedObj.success) return node;
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsedObj.data)) {
    if (k === "$schema") continue;
    obj[k] = sanitizeSchemaForCodex(v);
  }
  if (obj.type === "object") {
    obj.additionalProperties = false;
    const propsParsed = JsonRecordSchema.safeParse(obj.properties);
    if (propsParsed.success) {
      obj.required = Object.keys(propsParsed.data);
    }
  }
  return obj;
}

export function buildCodexExecArgs(params: {
  modelName: string;
  reasoningEffort?: ReasoningEffort | undefined;
  outPath: string;
  schemaPath?: string | undefined;
  cdDir?: string | undefined;
}): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    params.cdDir ?? tmpdir(),
    "--json",
    "-o",
    params.outPath,
  ];
  if (params.modelName !== "default") {
    args.push("-m", params.modelName);
  }
  if (params.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${params.reasoningEffort}`);
  }
  if (params.schemaPath) {
    args.push("--output-schema", params.schemaPath);
  }
  args.push("-");
  return args;
}

async function runCodexCli(params: {
  modelName: string;
  reasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  system?: string | undefined;
  prompt: string;
  jsonSchema?: Record<string, unknown> | undefined;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const dir = mkdtempSync(join(tmpdir(), "distill-anything-codex-"));
  try {
    const outPath = join(dir, "out.txt");
    let schemaPath: string | undefined;
    if (params.jsonSchema) {
      schemaPath = join(dir, "schema.json");
      writeFileSync(schemaPath, JSON.stringify(sanitizeSchemaForCodex(params.jsonSchema)), "utf8");
    }
    const args = buildCodexExecArgs({
      modelName: params.modelName,
      reasoningEffort: params.reasoningEffort,
      outPath,
      schemaPath,
    });
    const codexBin = params.codexPath ?? findCodexExecutable() ?? "codex";

    const fullPrompt = params.system ? `${params.system}\n\n---\n\n${params.prompt}` : params.prompt;
    const proc = Bun.spawn([codexBin, ...args], {
      stdin: new Response(fullPrompt),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`codex exec failed (exit ${exitCode}): ${stderrText.trim() || stdoutText.trim()}`);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    for (const line of stdoutText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const evt = JSON.parse(trimmed) as { type?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        if (evt.type === "turn.completed" && evt.usage) {
          inputTokens = evt.usage.input_tokens ?? 0;
          outputTokens = evt.usage.output_tokens ?? 0;
        }
      } catch {
        // Ignore non-JSONL lines
      }
    }
    const text = readFileSync(outPath, "utf8").trim();
    return { text, inputTokens, outputTokens };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface BaseLlmCallParams {
  stage: StageCost["stage"];
  modelId: string;
  reasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  system?: string;
  prompt: string;
  maxOutputTokens: number;
  budget: BudgetLedger;
}

async function executeCodexCall(
  params: BaseLlmCallParams & { jsonSchema?: Record<string, unknown> },
): Promise<{ text: string; cost: StageCost }> {
  const combinedPrompt = `${params.system ?? ""}\n${params.prompt}`;
  params.budget.assertWithinBudget(params.modelId, combinedPrompt, params.maxOutputTokens);

  const { modelName } = parseModelId(params.modelId);
  const start = Date.now();

  const res = await withExponentialBackoff(() =>
    runCodexCli({
      modelName,
      reasoningEffort: params.reasoningEffort,
      codexPath: params.codexPath,
      system: params.system,
      prompt: params.prompt,
      jsonSchema: params.jsonSchema,
    }),
  );
  const durationMs = Date.now() - start;
  const cost = params.budget.recordUsage(params.stage, params.modelId, res.inputTokens, res.outputTokens, durationMs);
  return { text: res.text, cost };
}

export async function callStructuredLlm<T extends z.ZodTypeAny>(
  params: BaseLlmCallParams & { schema: T },
): Promise<{ object: z.infer<T>; cost: StageCost }> {
  // SAFETY: zodToJsonSchema always returns a JSON Schema object for any ZodTypeAny input.
  const jsonSchema = zodToJsonSchema(params.schema, { $refStrategy: "none" }) as Record<string, unknown>;
  const { text, cost } = await executeCodexCall({ ...params, jsonSchema });
  const parsed = params.schema.parse(JSON.parse(text));
  return { object: parsed, cost };
}

export async function callTextLlm(
  params: BaseLlmCallParams,
): Promise<{ text: string; cost: StageCost }> {
  return executeCodexCall(params);
}
