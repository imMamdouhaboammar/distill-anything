import { Command } from "commander";
import { z } from "zod";
import { ReasoningEffortSchema } from "../core/config";

const SkillNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill name must be kebab-case")
  .optional();

const MinNoveltySchema = z.coerce
  .number()
  .int("min-novelty must be an integer between 1 and 5")
  .min(1, "min-novelty must be between 1 and 5")
  .max(5, "min-novelty must be between 1 and 5");

const SharedOptionsShape = {
  out: z.string().default("./.claude/skills"),
  name: SkillNameSchema,
  subpath: z.string().default("."),
  model: z.string().default("codex:default"),
  judgeModel: z.string().default("codex:default"),
  modelExplicit: z.boolean().default(false),
  judgeModelExplicit: z.boolean().default(false),
  reasoning: ReasoningEffortSchema.optional(),
  judgeReasoning: ReasoningEffortSchema.optional(),
  reconfigure: z.boolean().default(false),
  maxBudget: z.coerce.number().positive().default(2.0),
  gitDepth: z.coerce.number().int().positive().max(2000).default(150),
  skipNovelty: z.boolean().default(false),
  noGit: z.boolean().default(false),
  json: z.boolean().default(false),
};

export const CliConfigOptionsSchema = z.object({
  mode: z.literal("config"),
  json: z.boolean().default(false),
});

export const CliScanOrgOptionsSchema = z.object({
  mode: z.literal("scan-org"),
  org: z.string().min(1, "GitHub organization name is required"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  lang: z.string().min(1).optional(),
  minStars: z.coerce.number().int().nonnegative().default(50),
  maxSizeMb: z.coerce.number().positive().default(150),
  includeForks: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  concurrency: z.coerce.number().int().min(1).max(10).default(3),
  out: z.string().min(1).optional(),
  json: z.boolean().default(false),
});

export const CliRepoOptionsSchema = z.object({
  mode: z.literal("repo").default("repo"),
  source: z.string().min(1, "Source repository path or URL is required"),
  ...SharedOptionsShape,
  minNovelty: MinNoveltySchema.default(4),
  maxFiles: z.coerce.number().int().positive().max(100).default(20),
  maxCommits: z.coerce.number().int().nonnegative().max(50).default(15),
  dryRun: z.boolean().default(false),
  update: z.boolean().default(false),
});

export const CliFromFindingsOptionsSchema = z
  .object({
    mode: z.literal("from-findings"),
    findingsFile: z.string().min(1, "Findings file path is required"),
    repo: z.string().min(1).optional(),
    allowUngrounded: z.boolean().default(false),
    ...SharedOptionsShape,
    minNovelty: MinNoveltySchema.default(3),
  })
  .superRefine((val, ctx) => {
    if (!val.repo && !val.allowUngrounded) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either --repo <local-path-or-url> or --allow-ungrounded is required for from-findings.",
        path: ["repo"],
      });
    }
  });

export const CliMergeOptionsSchema = z.object({
  mode: z.literal("merge"),
  skillDirs: z.array(z.string().min(1)).min(1, "At least one skill directory or parent directory is required"),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill name (--name) is required and must be kebab-case"),
  out: z.string().default("./.claude/skills"),
  maxPatterns: z.coerce.number().int().min(1).max(15).default(12),
  model: z.string().default("codex:default"),
  modelExplicit: z.boolean().default(false),
  reasoning: ReasoningEffortSchema.optional(),
  maxBudget: z.coerce.number().positive().default(2.0),
  json: z.boolean().default(false),
});

export const CliOptionsSchema = z.union([
  CliConfigOptionsSchema,
  CliScanOrgOptionsSchema,
  CliMergeOptionsSchema,
  CliRepoOptionsSchema,
  CliFromFindingsOptionsSchema,
]);

export type CliConfigOptions = z.infer<typeof CliConfigOptionsSchema>;
export type CliScanOrgOptions = z.infer<typeof CliScanOrgOptionsSchema>;
export type CliMergeOptions = z.infer<typeof CliMergeOptionsSchema>;
export type CliRepoOptions = z.infer<typeof CliRepoOptionsSchema>;
export type CliFromFindingsOptions = z.infer<typeof CliFromFindingsOptionsSchema>;
export type CliOptions = z.infer<typeof CliOptionsSchema>;

export function parseCliArgs(argv: string[]): CliOptions {
  const program = new Command();
  let parsedResult: CliOptions | undefined;

  program
    .name("distill-anything")
    .description("Distill Anything — distill transferable engineering playbooks from any repo or findings into an Agent Skill")
    .exitOverride();

  program
    .command("config")
    .description("Interactively configure default Codex CLI model and reasoning effort")
    .option("--json", "Emit saved configuration as JSON to stdout", false)
    .action((opts: Record<string, unknown>) => {
      parsedResult = CliConfigOptionsSchema.parse({
        mode: "config",
        json: Boolean(opts.json),
      });
    });

  program
    .command("scan-org")
    .description("Triage and rank repositories in a GitHub organization with zero LLM cost")
    .argument("<org>", "GitHub organization name (e.g. NVIDIA, anthropics, vercel-labs)")
    .option("--limit <n>", "Number of recently pushed repositories to inspect (max 100)", "20")
    .option("--lang <language>", "Filter by primary language (e.g. python, rust, typescript, cuda, c++)")
    .option("--min-stars <n>", "Skip repositories with fewer than N stars", "50")
    .option("--max-size-mb <n>", "Skip repositories larger than N MB before cloning", "150")
    .option("--include-forks", "Include forked repositories", false)
    .option("--include-archived", "Include archived repositories", false)
    .option("--concurrency <n>", "Max parallel shallow clones", "3")
    .option("--out <file>", "Save ranked JSON report to file")
    .option("--json", "Emit machine-readable JSON to stdout", false)
    .action((org: string, _opts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<Record<string, unknown>>();
      const outExplicit =
        cmd.getOptionValueSource("out") === "cli" ||
        cmd.parent?.getOptionValueSource("out") === "cli";
      parsedResult = CliScanOrgOptionsSchema.parse({
        mode: "scan-org",
        org,
        limit: opts.limit,
        lang: opts.lang,
        minStars: opts.minStars,
        maxSizeMb: opts.maxSizeMb,
        includeForks: Boolean(opts.includeForks),
        includeArchived: Boolean(opts.includeArchived),
        concurrency: opts.concurrency,
        out: outExplicit ? opts.out : undefined,
        json: Boolean(opts.json),
      });
    });

  program
    .command("merge")
    .description("Synthesize multiple distilled skills into one unified cross-repo playbook")
    .argument("<skill-dirs...>", "Two or more skill directories, or a parent directory containing skills")
    .option("--name <slug>", "Output unified skill slug (kebab-case, required)")
    .option("--out <dir>", "Output directory where <slug>/ will be written", "./.claude/skills")
    .option("--max-patterns <n>", "Maximum patterns in unified playbook (default 12, hard max 15)", "12")
    .option("--model <id>", "Model for cross-repo synthesis (default: codex:<saved-model>)")
    .option("--reasoning <effort>", "Override Codex reasoning effort (low|medium|high|xhigh)")
    .option("--max-budget <usd>", "Hard USD cap", "2.00")
    .option("--json", "Emit machine-readable report to stdout", false)
    .action((skillDirs: string[], _opts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<Record<string, unknown>>();
      const modelExplicit =
        cmd.getOptionValueSource("model") === "cli" ||
        cmd.parent?.getOptionValueSource("model") === "cli";
      parsedResult = CliMergeOptionsSchema.parse({
        mode: "merge",
        skillDirs,
        name: opts.name,
        out: opts.out,
        maxPatterns: opts.maxPatterns,
        model: opts.model ?? "codex:default",
        modelExplicit,
        reasoning: opts.reasoning,
        maxBudget: opts.maxBudget,
        json: Boolean(opts.json),
      });
    });

  program
    .command("from-findings")
    .description("Structure existing architectural findings into a verified Agent Skill")
    .argument("<findings-file>", "Path to Markdown, text, or JSON file containing raw findings")
    .option("--repo <source>", "Local path or Git URL used for deterministic snippet grounding")
    .option("--allow-ungrounded", "Allow skipping disk grounding when no --repo is available", false)
    .option("--out <dir>", "Output directory where <skill-slug>/ will be written", "./.claude/skills")
    .option("--name <slug>", "Override output skill folder name (kebab-case)")
    .option("--subpath <path>", "Restrict analysis to a package inside a monorepo", ".")
    .option("--model <id>", "Primary model for structuring findings (default: codex:<saved-model>)")
    .option("--judge-model <id>", "Model for Stage 4 blind baseline and judging (default: codex:<saved-model>)")
    .option("--reasoning <effort>", "Override Codex reasoning effort (low|medium|high|xhigh)")
    .option("--judge-reasoning <effort>", "Override Codex judge reasoning effort (low|medium|high|xhigh)")
    .option("--reconfigure", "Re-run interactive Codex setup before executing", false)
    .option("--max-budget <usd>", "Hard USD cap", "2.00")
    .option("--git-depth <n>", "Shallow clone depth for remote repositories", "150")
    .option("--min-novelty <1-5>", "Minimum novelty score (1-5) required to keep a pattern (default: 3)")
    .option("--skip-novelty", "Bypass Stage 4 (marks output unverified)", false)
    .option("--no-git", "Skip git metadata resolution")
    .option("--json", "Emit machine-readable report to stdout", false)
    .action((findingsFile: string, _opts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<Record<string, unknown>>();
      const modelExplicit = cmd.getOptionValueSource("model") === "cli";
      const judgeModelExplicit = cmd.getOptionValueSource("judgeModel") === "cli";
      parsedResult = CliFromFindingsOptionsSchema.parse({
        mode: "from-findings",
        findingsFile,
        repo: opts.repo,
        allowUngrounded: Boolean(opts.allowUngrounded),
        out: opts.out,
        name: opts.name,
        subpath: opts.subpath,
        model: opts.model ?? "codex:default",
        judgeModel: opts.judgeModel ?? "codex:default",
        modelExplicit,
        judgeModelExplicit,
        reasoning: opts.reasoning,
        judgeReasoning: opts.judgeReasoning,
        reconfigure: Boolean(opts.reconfigure),
        maxBudget: opts.maxBudget,
        gitDepth: opts.gitDepth,
        minNovelty: opts.minNovelty,
        skipNovelty: Boolean(opts.skipNovelty),
        noGit: opts.git === false,
        json: Boolean(opts.json),
      });
    });

  program
    .argument("[source]", "Local path or Git URL (https://... or git@...)")
    .option("--out <dir>", "Output directory where <skill-slug>/ will be written", "./.claude/skills")
    .option("--name <slug>", "Override output skill folder name (kebab-case)")
    .option("--subpath <path>", "Restrict analysis to a package inside a monorepo", ".")
    .option("--model <id>", "Primary model for Stage 3 Pattern Mining (default: codex:<saved-model>)")
    .option("--judge-model <id>", "Model for Stage 4 blind baseline and judging (default: codex:<saved-model>)")
    .option("--reasoning <effort>", "Override Codex reasoning effort (low|medium|high|xhigh)")
    .option("--judge-reasoning <effort>", "Override Codex judge reasoning effort (low|medium|high|xhigh)")
    .option("--reconfigure", "Re-run interactive Codex setup before executing", false)
    .option("--max-budget <usd>", "Hard USD cap", "2.00")
    .option("--max-files <n>", "Maximum source files included in SignalBundle", "20")
    .option("--max-commits <n>", "Maximum high-signal git diffs included in SignalBundle", "15")
    .option("--git-depth <n>", "Shallow clone depth for remote repositories", "150")
    .option("--min-novelty <1-5>", "Minimum novelty score (1-5) required to keep a pattern (default: 4)")
    .option("--skip-novelty", "Bypass Stage 4 (marks output unverified)", false)
    .option("--dry-run", "Run Stages 1 & 2 only; print SignalBundle stats and estimated USD cost", false)
    .option("--update", "Incrementally update an existing skill directory from git delta since lastCommitSha", false)
    .option("--no-git", "Skip git history mining for repositories without commit logs")
    .option("--json", "Emit machine-readable report to stdout", false)
    .action((source: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      const modelExplicit = cmd.getOptionValueSource("model") === "cli";
      const judgeModelExplicit = cmd.getOptionValueSource("judgeModel") === "cli";
      parsedResult = CliRepoOptionsSchema.parse({
        mode: "repo",
        source,
        out: opts.out,
        name: opts.name,
        subpath: opts.subpath,
        model: opts.model ?? "codex:default",
        judgeModel: opts.judgeModel ?? "codex:default",
        modelExplicit,
        judgeModelExplicit,
        reasoning: opts.reasoning,
        judgeReasoning: opts.judgeReasoning,
        reconfigure: Boolean(opts.reconfigure),
        maxBudget: opts.maxBudget,
        maxFiles: opts.maxFiles,
        maxCommits: opts.maxCommits,
        gitDepth: opts.gitDepth,
        minNovelty: opts.minNovelty,
        skipNovelty: Boolean(opts.skipNovelty),
        dryRun: Boolean(opts.dryRun),
        update: Boolean(opts.update),
        noGit: opts.git === false,
        json: Boolean(opts.json),
      });
    });

  program.parse(argv);
  if (!parsedResult) {
    throw new Error("No CLI command matched.");
  }
  return parsedResult;
}
