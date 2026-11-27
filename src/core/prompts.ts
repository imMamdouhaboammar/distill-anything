import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function resolvePromptPath(filename: string): string {
  const candidates = [
    resolve(import.meta.dir, "../../prompts", filename),
    resolve(dirname(process.execPath), "prompts", filename),
    resolve(process.cwd(), "prompts", filename),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Prompt template not found: ${filename}`);
}

export function loadPromptTemplate(filename: string): string {
  return readFileSync(resolvePromptPath(filename), "utf8");
}

/**
 * Simple template renderer supporting `{{key}}` and `{{#if key}}...{{/if}}` blocks.
 */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  let out = template.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, key: string, body: string) => {
    const val = vars[key];
    return val && val.trim().length > 0 ? body : "";
  });

  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");
  return out;
}
