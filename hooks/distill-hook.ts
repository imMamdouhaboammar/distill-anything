#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { countTokens } from "../src/core/tokens";

interface HookPayload {
  tool_name?: string;
  tool?: string;
  toolCall?: { name?: string; args?: Record<string, unknown> };
  tool_input?: Record<string, unknown>;
  input?: Record<string, unknown>;
}

export const SKILL_INDEX_CAP = 1200;
export const PATTERN_FILE_CAP = 900;

function extractTargetPath(payload: HookPayload): string {
  const input = payload.tool_input ?? payload.input ?? payload.toolCall?.args ?? {};
  const raw = input.Path ?? input.path ?? input.file_path ?? input.TargetFile ?? "";
  return typeof raw === "string" ? raw : "";
}

export function evaluateDistillHook(phase: string, payload: HookPayload): Record<string, unknown> {
  const targetPath = extractTargetPath(payload);
  const normalized = targetPath.replace(/\\/g, "/");
  const isSkillMd = basename(normalized) === "SKILL.md" && /\/.?(?:claude|agents)\/skills\//.test(normalized);
  const isPatternMd = /\/references\/patterns\/[^/]+\.md$/.test(normalized);

  if (phase === "PreToolUse") {
    return { decision: "allow" };
  }

  if (phase === "PostToolUse" && (isSkillMd || isPatternMd) && existsSync(normalized)) {
    const tokens = countTokens(readFileSync(normalized, "utf8"));
    const cap = isSkillMd ? SKILL_INDEX_CAP : PATTERN_FILE_CAP;
    if (tokens > cap) {
      process.stderr.write(
        `distill-anything token cap warning: ${basename(normalized)} is ${tokens} tokens (hard cap is ${cap}).\n`,
      );
    }
  }

  return {};
}

if (import.meta.main) {
  const phase = process.argv[2] ?? "PreToolUse";
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "{}";
  }
  let payload: HookPayload = {};
  try {
    payload = raw.trim() ? (JSON.parse(raw) as HookPayload) : {};
  } catch {
    payload = {};
  }
  const output = evaluateDistillHook(phase, payload);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
