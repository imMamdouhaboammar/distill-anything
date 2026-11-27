import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateObject, generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { z } from "zod";
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
    super(`Missing API key for provider "${provider}". Set ${envVar} in your environment.`);
    this.name = "MissingApiKeyError";
  }
}

export class InvalidModelError extends Error {
  constructor(modelId: string) {
    super(`Invalid model specifier "${modelId}". Expected "<provider>:<model>" (e.g. "codex:gpt-5.4").`);
    this.name = "InvalidModelError";
  }
}

export function parseModelId(modelId: string): { provider: string; modelName: string } {
  const idx = modelId.indexOf(":");
  if (idx <= 0 || idx === modelId.length - 1) {
    throw new InvalidModelError(modelId);
  }
  return {
    provider: modelId.slice(0, idx),
    modelName: modelId.slice(idx + 1),
  };
}

export function validateApiKeys(modelIds: string[]): void {
  for (const id of modelIds) {
    const { provider } = parseModelId(id);
    if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
      throw new MissingApiKeyError("anthropic", "ANTHROPIC_API_KEY");
    }
    if (provider === "openai" && !process.env.OPENAI_API_KEY) {
      throw new MissingApiKeyError("openai", "OPENAI_API_KEY");
    }
    if (provider === "google" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new MissingApiKeyError("google", "GOOGLE_GENERATIVE_AI_API_KEY");
    }
    if (provider === "codex" && !findCodexExecutable()) {
      throw new MissingApiKeyError("codex", "codex CLI in PATH or DISTILL_CODEX_PATH");
    }
    if (provider === "gcloud" && !Bun.which("gcloud")) {
      throw new MissingApiKeyError("gcloud", "gcloud CLI in PATH");
    }
  }
}

function resolveModel(modelId: string): LanguageModel {
  const { provider, modelName } = parseModelId(modelId);
  switch (provider) {
    case "anthropic": {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new MissingApiKeyError("anthropic", "ANTHROPIC_API_KEY");
      }
      const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      return anthropic(modelName);
    }
    case "openai": {
      if (!process.env.OPENAI_API_KEY) {
        throw new MissingApiKeyError("openai", "OPENAI_API_KEY");
      }
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
      return openai(modelName);
    }
    case "google": {
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        throw new MissingApiKeyError("google", "GOOGLE_GENERATIVE_AI_API_KEY");
      }
      const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
      return google(modelName);
    }
    default:
      throw new InvalidModelError(modelId);
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

function extractTokenUsage(usage: unknown): { inputTokens: number; outputTokens: number } {
  const u = (usage ?? {}) as Record<string, unknown>;
  const input =
    typeof u.inputTokens === "number"
      ? u.inputTokens
      : typeof u.promptTokens === "number"
        ? u.promptTokens
        : 0;
  const output =
    typeof u.outputTokens === "number"
      ? u.outputTokens
      : typeof u.completionTokens === "number"
        ? u.completionTokens
        : 0;
  return { inputTokens: input, outputTokens: output };
}

function sanitizeSchemaForCodex(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForCodex);
  if (!node || typeof node !== "object") return node;
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema") continue;
    obj[k] = sanitizeSchemaForCodex(v);
  }
  if (obj.type === "object") {
    obj.additionalProperties = false;
    if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
      obj.required = Object.keys(obj.properties as Record<string, unknown>);
    }
  }
  return obj;
}

function sanitizeSchemaForVertex(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForVertex);
  if (!node || typeof node !== "object") return node;
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema" || k === "additionalProperties" || k === "exclusiveMinimum" || k === "exclusiveMaximum") {
      continue;
    }
    obj[k] = sanitizeSchemaForVertex(v);
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
  jsonSchema?: Record<string, unknown>;
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

let cachedGcloudAuth: { token: string; project: string; expiresAt: number } | null = null;

async function getGcloudAuth(): Promise<{ token: string; project: string }> {
  if (cachedGcloudAuth && Date.now() < cachedGcloudAuth.expiresAt) {
    return { token: cachedGcloudAuth.token, project: cachedGcloudAuth.project };
  }
  const tokenProc = Bun.spawnSync(["gcloud", "auth", "print-access-token"], { stdout: "pipe", stderr: "pipe" });
  if (tokenProc.exitCode !== 0) {
    throw new Error(`gcloud auth print-access-token failed: ${new TextDecoder().decode(tokenProc.stderr).trim()}`);
  }
  const projProc = Bun.spawnSync(["gcloud", "config", "get-value", "project"], { stdout: "pipe", stderr: "pipe" });
  const project = new TextDecoder().decode(projProc.stdout).trim();
  if (!project) {
    throw new Error("No active gcloud project configured (run: gcloud config set project <id>).");
  }
  const token = new TextDecoder().decode(tokenProc.stdout).trim();
  cachedGcloudAuth = { token, project, expiresAt: Date.now() + 30 * 60 * 1000 };
  return { token, project };
}

async function runGcloudVertex(params: {
  modelName: string;
  system?: string | undefined;
  prompt: string;
  maxOutputTokens: number;
  temperature: number;
  jsonSchema?: Record<string, unknown>;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const { token, project } = await getGcloudAuth();
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${params.modelName}:generateContent`;

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: params.maxOutputTokens,
    temperature: params.temperature,
  };
  if (params.modelName.includes("2.5")) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  if (params.jsonSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = sanitizeSchemaForVertex(params.jsonSchema);
  }

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: params.prompt }] }],
    generationConfig,
  };
  if (params.system) {
    body.systemInstruction = { parts: [{ text: params.system }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vertex AI (${res.status}): ${errText}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

export async function callStructuredLlm<T extends z.ZodTypeAny>(params: {
  stage: StageCost["stage"];
  modelId: string;
  reasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  system?: string;
  prompt: string;
  schema: T;
  maxOutputTokens: number;
  budget: BudgetLedger;
}): Promise<{ object: z.infer<T>; cost: StageCost }> {
  const combinedPrompt = `${params.system ?? ""}\n${params.prompt}`;
  params.budget.assertWithinBudget(params.modelId, combinedPrompt, params.maxOutputTokens);

  const { provider, modelName } = parseModelId(params.modelId);
  const start = Date.now();

  if (provider === "codex" || provider === "gcloud") {
    const jsonSchema = zodToJsonSchema(params.schema, { $refStrategy: "none" }) as Record<string, unknown>;
    const res = await withExponentialBackoff(() =>
      provider === "codex"
        ? runCodexCli({
            modelName,
            reasoningEffort: params.reasoningEffort,
            codexPath: params.codexPath,
            system: params.system,
            prompt: params.prompt,
            jsonSchema,
          })
        : runGcloudVertex({
            modelName,
            system: params.system,
            prompt: params.prompt,
            maxOutputTokens: params.maxOutputTokens,
            temperature: 0.1,
            jsonSchema,
          }),
    );
    const parsed = params.schema.parse(JSON.parse(res.text));
    const durationMs = Date.now() - start;
    const cost = params.budget.recordUsage(params.stage, params.modelId, res.inputTokens, res.outputTokens, durationMs);
    return { object: parsed, cost };
  }

  const model = resolveModel(params.modelId);
  const callArgs: Parameters<typeof generateObject>[0] = {
    model,
    prompt: params.prompt,
    schema: params.schema,
    maxOutputTokens: params.maxOutputTokens,
    temperature: 0.1,
  };
  if (params.system !== undefined) {
    callArgs.system = params.system;
  }
  const result = await withExponentialBackoff(() => generateObject(callArgs));
  const durationMs = Date.now() - start;
  const { inputTokens, outputTokens } = extractTokenUsage(result.usage);
  const cost = params.budget.recordUsage(params.stage, params.modelId, inputTokens, outputTokens, durationMs);
  return { object: result.object, cost };
}

export async function callTextLlm(params: {
  stage: StageCost["stage"];
  modelId: string;
  reasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  system?: string;
  prompt: string;
  maxOutputTokens: number;
  budget: BudgetLedger;
}): Promise<{ text: string; cost: StageCost }> {
  const combinedPrompt = `${params.system ?? ""}\n${params.prompt}`;
  params.budget.assertWithinBudget(params.modelId, combinedPrompt, params.maxOutputTokens);

  const { provider, modelName } = parseModelId(params.modelId);
  const start = Date.now();

  if (provider === "codex" || provider === "gcloud") {
    const res = await withExponentialBackoff(() =>
      provider === "codex"
        ? runCodexCli({
            modelName,
            reasoningEffort: params.reasoningEffort,
            codexPath: params.codexPath,
            system: params.system,
            prompt: params.prompt,
          })
        : runGcloudVertex({
            modelName,
            system: params.system,
            prompt: params.prompt,
            maxOutputTokens: params.maxOutputTokens,
            temperature: 0.2,
          }),
    );
    const durationMs = Date.now() - start;
    const cost = params.budget.recordUsage(params.stage, params.modelId, res.inputTokens, res.outputTokens, durationMs);
    return { text: res.text, cost };
  }

  const model = resolveModel(params.modelId);
  const callArgs: Parameters<typeof generateText>[0] = {
    model,
    prompt: params.prompt,
    maxOutputTokens: params.maxOutputTokens,
    temperature: 0.2,
  };
  if (params.system !== undefined) {
    callArgs.system = params.system;
  }
  const result = await withExponentialBackoff(() => generateText(callArgs));
  const durationMs = Date.now() - start;
  const { inputTokens, outputTokens } = extractTokenUsage(result.usage);
  const cost = params.budget.recordUsage(params.stage, params.modelId, inputTokens, outputTokens, durationMs);
  return { text: result.text, cost };
}
