#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { z } from "zod";
import { executeMcpTool, MCP_TOOLS } from "../src/mcp/server";
import { verifySkillDirectory } from "../src/mcp/verify";

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

function writeResponse(id: string | number | null | undefined, result: unknown): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id: string | number | null | undefined, code: number, message: string): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function main(): Promise<void> {
  const verifyIdx = process.argv.indexOf("--verify");
  if (verifyIdx !== -1) {
    const skillDir = process.argv[verifyIdx + 1];
    if (!skillDir) {
      process.stderr.write("Usage: distill-anything-mcp --verify <skill-dir> [repo-path]\n");
      process.exit(2);
    }
    const repoPath = process.argv[verifyIdx + 2];
    const report = verifySkillDirectory(skillDir, repoPath);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JsonRpcRequestSchema.parse(JSON.parse(trimmed));
    } catch {
      writeError(null, -32700, "Parse error");
      continue;
    }

    switch (req.method) {
      case "initialize":
        writeResponse(req.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "distill-anything", version: "2.0.0" },
        });
        break;

      case "notifications/initialized":
        break;

      case "ping":
        writeResponse(req.id, {});
        break;

      case "tools/list":
        writeResponse(req.id, { tools: MCP_TOOLS });
        break;

      case "tools/call": {
        const toolName = typeof req.params?.name === "string" ? req.params.name : "";
        const toolArgs = req.params?.arguments;
        const output = await executeMcpTool(toolName, toolArgs);
        writeResponse(req.id, output);
        break;
      }

      default:
        if (req.id !== undefined) {
          writeError(req.id, -32601, `Method not found: ${req.method}`);
        }
        break;
    }
  }
}

void main();
