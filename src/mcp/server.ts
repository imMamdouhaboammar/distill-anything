import { resolve } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BudgetLedger } from "../core/budget";
import { ReasoningEffortSchema } from "../core/config";
import { ingestRepository } from "../stages/01-ingest";
import { buildSignalBundle } from "../stages/02-signals/bundler";
import { scanOrganization } from "../stages/org-scan/scanner";
import { verifySkillDirectory } from "./verify";

const DryRunInputSchema = z.object({
  source: z.string().min(1).describe("Local path or Git URL (https://... or git@...)"),
  subpath: z.string().default(".").describe("Subpath inside monorepo"),
  maxFiles: z.number().int().min(1).max(100).default(40),
  maxCommits: z.number().int().min(0).max(50).default(25),
  gitDepth: z.number().int().min(1).max(2000).default(150),
  noGit: z.boolean().default(false),
});

const ScanOrgInputSchema = z.object({
  org: z.string().min(1).describe("GitHub organization name"),
  limit: z.number().int().min(1).max(100).default(20),
  lang: z.string().min(1).optional(),
  minStars: z.number().int().nonnegative().default(50),
  maxSizeMb: z.number().positive().default(150),
  includeForks: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(10).default(3),
});

const VerifySkillInputSchema = z.object({
  skillDir: z.string().min(1).describe("Path to compiled skill directory containing SKILL.md"),
  repoPath: z.string().min(1).optional().describe("Optional local repository root to verify cited file paths"),
});

const DistillRepoInputSchema = z.object({
  source: z.string().min(1).describe("Local path or Git URL"),
  out: z.string().default("./.claude/skills"),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  subpath: z.string().default("."),
  model: z.string().optional(),
  reasoning: ReasoningEffortSchema.optional(),
  minNovelty: z.number().int().min(1).max(5).default(3),
  maxBudget: z.number().positive().default(10.0),
  update: z.boolean().default(false),
  noGit: z.boolean().default(false),
});

const DistillFromFindingsInputSchema = z.object({
  findingsFile: z.string().min(1).describe("Path to Markdown, text, or JSON findings file"),
  repo: z.string().min(1).optional().describe("Local path or Git URL for disk grounding"),
  allowUngrounded: z.boolean().default(false),
  out: z.string().default("./.claude/skills"),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  model: z.string().optional(),
  reasoning: ReasoningEffortSchema.optional(),
  minNovelty: z.number().int().min(1).max(5).default(3),
  maxBudget: z.number().positive().default(10.0),
});

const DistillMergeInputSchema = z.object({
  skillDirs: z.array(z.string().min(1)).min(1).describe("Skill directories or parent directory"),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe("Output unified skill slug"),
  out: z.string().default("./.claude/skills"),
  maxPatterns: z.number().int().min(1).max(15).default(12),
  model: z.string().optional(),
  reasoning: ReasoningEffortSchema.optional(),
  maxBudget: z.number().positive().default(10.0),
});

const DistillPublishInputSchema = z.object({
  skillDir: z.string().min(1).describe("Compiled skill directory to publish"),
  repo: z.string().min(1).optional().describe("Target awesome repo (owner/repo or Git URL)"),
  branch: z.string().min(1).optional(),
});

const DistillDiscussInputSchema = z.object({
  skillDir: z.string().min(1).describe("Compiled skill directory to share in a GitHub Discussion"),
  target: z.enum(["auto", "source", "awesome"]).default("auto"),
  repo: z.string().min(1).optional().describe("Explicit target GitHub repo (owner/repo)"),
  category: z.string().min(1).optional().describe("Discussion category name or slug"),
  dryRun: z.boolean().default(false),
});

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toMcpInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // SAFETY: zodToJsonSchema always returns a JSON Schema object for any ZodTypeAny input.
  return zodToJsonSchema(schema) as Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "distill_dry_run",
    description: "Run Stages 1 & 2 (ingest + AST/git signal bundling) with zero LLM cost and return RepoProfile and SignalBundle stats.",
    inputSchema: toMcpInputSchema(DryRunInputSchema),
  },
  {
    name: "distill_scan_org",
    description: "Triage and rank repositories in a GitHub organization by signal density with zero LLM cost.",
    inputSchema: toMcpInputSchema(ScanOrgInputSchema),
  },
  {
    name: "distill_verify_skill",
    description: "Verify a compiled skill directory for SKILL.md <= 1,200 tokens, pattern files <= 900 tokens, valid distill-report.json, and optional disk citations.",
    inputSchema: toMcpInputSchema(VerifySkillInputSchema),
  },
  {
    name: "distill_repo",
    description: "Distill a repository (or --update an existing skill) into a grounded, novelty-verified Agent Skill using Codex CLI.",
    inputSchema: toMcpInputSchema(DistillRepoInputSchema),
  },
  {
    name: "distill_from_findings",
    description: "Structure existing architectural findings into a grounded, novelty-verified Agent Skill.",
    inputSchema: toMcpInputSchema(DistillFromFindingsInputSchema),
  },
  {
    name: "distill_merge",
    description: "Synthesize two or more distilled skill directories into one unified cross-repo playbook.",
    inputSchema: toMcpInputSchema(DistillMergeInputSchema),
  },
  {
    name: "distill_publish",
    description: "Publish a compiled skill directory to an awesome-distilled-skills repository.",
    inputSchema: toMcpInputSchema(DistillPublishInputSchema),
  },
  {
    name: "distill_discuss",
    description: "Open a new GitHub Discussion with a distilled skill or playbook, mentioning the original repo owner(s).",
    inputSchema: toMcpInputSchema(DistillDiscussInputSchema),
  },
];

const JsonObjectSchema = z.record(z.string(), z.unknown());

function runCliJson(cliArgs: string[]): Record<string, unknown> {
  const cliEntry = resolve(import.meta.dir, "../../bin/distill-anything.ts");
  const proc = Bun.spawnSync(["bun", "run", cliEntry, ...cliArgs, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  if (proc.exitCode !== 0) {
    throw new Error(stderr || stdout || `distill-anything exited with code ${proc.exitCode}`);
  }
  if (!stdout) {
    return { ok: true };
  }
  try {
    return JsonObjectSchema.parse(JSON.parse(stdout));
  } catch {
    return { rawOutput: stdout };
  }
}

export async function executeMcpTool(
  name: string,
  rawArgs: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    let result: unknown;

    switch (name) {
      case "distill_dry_run": {
        const args = DryRunInputSchema.parse(rawArgs ?? {});
        const ingest = await ingestRepository({
          source: args.source,
          subpath: args.subpath,
          gitDepth: args.gitDepth,
          noGit: args.noGit,
        });
        try {
          const bundle = await buildSignalBundle({
            ingest,
            maxFiles: args.maxFiles,
            maxCommits: args.maxCommits,
            gitDepth: args.gitDepth,
          });
          const ledger = new BudgetLedger(2.0);
          result = {
            profile: ingest.profile,
            signalBundle: {
              totalTokens: bundle.totalTokens,
              fileCount: bundle.files.length,
              commitCount: bundle.commits.length,
              hasDocs: bundle.files.some((f) => f.bucket === "architecture_doc"),
              topFiles: bundle.files.slice(0, 10).map((f) => ({
                path: f.path,
                bucket: f.bucket,
                score: f.score,
                fanIn: f.fanIn,
                tokens: f.tokenCount,
              })),
            },
            estimatedCostUsd: ledger.estimateCallCost("codex:default", bundle.totalTokens, 4000),
          };
        } finally {
          ingest.cleanup();
        }
        break;
      }

      case "distill_scan_org": {
        const args = ScanOrgInputSchema.parse(rawArgs ?? {});
        const scanOpts: Parameters<typeof scanOrganization>[0] = {
          org: args.org,
          limit: args.limit,
          minStars: args.minStars,
          maxSizeMb: args.maxSizeMb,
          includeForks: args.includeForks,
          includeArchived: args.includeArchived,
          concurrency: args.concurrency,
        };
        if (args.lang) scanOpts.lang = args.lang;
        result = await scanOrganization(scanOpts);
        break;
      }

      case "distill_verify_skill": {
        const args = VerifySkillInputSchema.parse(rawArgs ?? {});
        result = verifySkillDirectory(args.skillDir, args.repoPath);
        break;
      }

      case "distill_repo": {
        const args = DistillRepoInputSchema.parse(rawArgs ?? {});
        const cliArgs = [
          args.source,
          "--out",
          args.out,
          "--subpath",
          args.subpath,
          "--min-novelty",
          String(args.minNovelty),
          "--max-budget",
          String(args.maxBudget),
        ];
        if (args.name) cliArgs.push("--name", args.name);
        if (args.model) cliArgs.push("--model", args.model);
        if (args.reasoning) cliArgs.push("--reasoning", args.reasoning);
        if (args.update) cliArgs.push("--update");
        if (args.noGit) cliArgs.push("--no-git");
        result = runCliJson(cliArgs);
        break;
      }

      case "distill_from_findings": {
        const args = DistillFromFindingsInputSchema.parse(rawArgs ?? {});
        const cliArgs = [
          "from-findings",
          args.findingsFile,
          "--out",
          args.out,
          "--min-novelty",
          String(args.minNovelty),
          "--max-budget",
          String(args.maxBudget),
        ];
        if (args.repo) cliArgs.push("--repo", args.repo);
        if (args.allowUngrounded) cliArgs.push("--allow-ungrounded");
        if (args.name) cliArgs.push("--name", args.name);
        if (args.model) cliArgs.push("--model", args.model);
        if (args.reasoning) cliArgs.push("--reasoning", args.reasoning);
        result = runCliJson(cliArgs);
        break;
      }

      case "distill_merge": {
        const args = DistillMergeInputSchema.parse(rawArgs ?? {});
        const cliArgs = [
          "merge",
          ...args.skillDirs,
          "--name",
          args.name,
          "--out",
          args.out,
          "--max-patterns",
          String(args.maxPatterns),
          "--max-budget",
          String(args.maxBudget),
        ];
        if (args.model) cliArgs.push("--model", args.model);
        if (args.reasoning) cliArgs.push("--reasoning", args.reasoning);
        result = runCliJson(cliArgs);
        break;
      }

      case "distill_publish": {
        const args = DistillPublishInputSchema.parse(rawArgs ?? {});
        const cliArgs = ["publish", args.skillDir];
        if (args.repo) cliArgs.push("--repo", args.repo);
        if (args.branch) cliArgs.push("--branch", args.branch);
        result = runCliJson(cliArgs);
        break;
      }

      case "distill_discuss": {
        const args = DistillDiscussInputSchema.parse(rawArgs ?? {});
        const cliArgs = ["discuss", args.skillDir, "--target", args.target];
        if (args.repo) cliArgs.push("--repo", args.repo);
        if (args.category) cliArgs.push("--category", args.category);
        if (args.dryRun) cliArgs.push("--dry-run");
        result = runCliJson(cliArgs);
        break;
      }

      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown MCP tool: ${name}` }],
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: msg }],
    };
  }
}
