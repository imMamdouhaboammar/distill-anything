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
  maxBudget: z.coerce.number().positive().default(10.0),
  gitDepth: z.coerce.number().int().positive().max(2000).default(150),
  skipNovelty: z.boolean().default(false),
  noGit: z.boolean().default(false),
  publish: z.boolean().default(true),
  publishRepo: z.string().min(1).optional(),
  discuss: z.boolean().optional(),
  discussTarget: z.enum(["auto", "source", "awesome"]).optional(),
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
  minNovelty: MinNoveltySchema.default(3),
  maxFiles: z.coerce.number().int().positive().max(100).default(40),
  maxCommits: z.coerce.number().int().nonnegative().max(50).default(25),
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
  maxBudget: z.coerce.number().positive().default(10.0),
  publish: z.boolean().default(true),
  publishRepo: z.string().min(1).optional(),
  discuss: z.boolean().optional(),
  discussTarget: z.enum(["auto", "source", "awesome"]).optional(),
  json: z.boolean().default(false),
});

export const CliPublishOptionsSchema = z.object({
  mode: z.literal("publish"),
  skillDir: z.string().min(1, "Skill directory path is required"),
  repo: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  setDefault: z.boolean().default(false),
  discuss: z.boolean().optional(),
  discussTarget: z.enum(["auto", "source", "awesome"]).optional(),
  json: z.boolean().default(false),
});

export const CliDiscussOptionsSchema = z.object({
  mode: z.literal("discuss"),
  skillDir: z.string().min(1, "Skill directory path is required"),
  target: z.enum(["auto", "source", "awesome"]).default("auto"),
  repo: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  awesomeRepo: z.string().min(1).optional(),
  open: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  json: z.boolean().default(false),
});

export const CliOptionsSchema = z.union([
  CliConfigOptionsSchema,
  CliScanOrgOptionsSchema,
  CliMergeOptionsSchema,
  CliPublishOptionsSchema,
  CliDiscussOptionsSchema,
  CliRepoOptionsSchema,
  CliFromFindingsOptionsSchema,
]);

export type CliConfigOptions = z.infer<typeof CliConfigOptionsSchema>;
export type CliScanOrgOptions = z.infer<typeof CliScanOrgOptionsSchema>;
export type CliMergeOptions = z.infer<typeof CliMergeOptionsSchema>;
export type CliPublishOptions = z.infer<typeof CliPublishOptionsSchema>;
export type CliDiscussOptions = z.infer<typeof CliDiscussOptionsSchema>;
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
    .option("--reasoning <effort>", "Override Codex thinking effort (low|medium|high|xhigh|max|ultra)")
    .option("--max-budget <usd>", "Hard USD cap", "10.00")
    .option("--publish", "Publish unified skill to the configured awesome repo (default: enabled)")
    .option("--publish-repo <repo>", "Override awesome repository (owner/repo or Git URL)")
    .option("--discuss", "Open a new GitHub Discussion with the unified playbook")
    .option("--discuss-target <target>", "Discussion target repo (auto|source|awesome)")
    .option("--json", "Emit machine-readable report to stdout", false)
    .action((skillDirs: string[], _opts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<Record<string, unknown>>();
      const modelExplicit =
        cmd.getOptionValueSource("model") === "cli" ||
        cmd.parent?.getOptionValueSource("model") === "cli";
      const publishExplicit = cmd.getOptionValueSource("publish") === "cli";
      const rawOpts: Record<string, unknown> = {
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
      };
      if (publishExplicit) rawOpts.publish = Boolean(opts.publish);
      if (opts.publishRepo) rawOpts.publishRepo = opts.publishRepo;
      if (opts.discuss) rawOpts.discuss = true;
      if (opts.discussTarget) rawOpts.discussTarget = opts.discussTarget;
      parsedResult = CliMergeOptionsSchema.parse(rawOpts);
    });

  program
    .command("publish")
    .description("Publish a compiled skill directory to an awesome-distilled-skills repository")
    .argument("<skill-dir>", "Path to compiled skill directory (containing SKILL.md and distill-report.json)")
    .option("--repo <repo>", "Target awesome repository (owner/repo or Git URL)")
    .option("--branch <branch>", "Target git branch (default: main)")
    .option("--set-default", "Save --repo as the default auto-publish repository in config", false)
    .option("--discuss", "Open a new GitHub Discussion with the published playbook")
    .option("--discuss-target <target>", "Discussion target repo (auto|source|awesome)")
    .option("--json", "Emit machine-readable JSON result to stdout", false)
    .action((skillDir: string, _opts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<Record<string, unknown>>();
      const rawOpts: Record<string, unknown> = {
        mode: "publish",
        skillDir,
        setDefault: Boolean(opts.setDefault),
        json: Boolean(opts.json),
      };
      if (opts.repo) rawOpts.repo = opts.repo;
      if (opts.branch) rawOpts.branch = opts.branch;
      if (opts.discuss) rawOpts.discuss = true;
      if (opts.discussTarget) rawOpts.discussTarget = opts.discussTarget;
      parsedResult = CliPublishOptionsSchema.parse(rawOpts);
    });

  program
    .command("discuss")
    .description("Open a new GitHub Discussion with a distilled skill or playbook (mentioning repo owners)")
    .argument("<skill-dir>", "Path to compiled skill directory (containing SKILL.md and distill-report.json)")
    .option("--target <target>", "Target repository mode: auto (source first, then awesome), source, or awesome", "auto")
    .option("--repo <repo>", "Explicit target GitHub repository (owner/repo or URL)")
    .option("--category <name>", "Discussion category name or slug (e.g. \"Show and tell\", \"General\")")
    .option("--awesome-repo <repo>", "Awesome repository linked in the discussion body")
    .option("--open", "Open pre-filled New Discussion page in browser instead of calling GitHub API", false)
    .option("--dry-run", "Preview generated discussion title, body, mentions, and URL without posting", false)
    .option("--json", "Emit machine-readable JSON result to stdout", false)
    .action((skillDir: string, _opts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<Record<string, unknown>>();
      const rawOpts: Record<string, unknown> = {
        mode: "discuss",
        skillDir,
        target: opts.target ?? "auto",
        open: Boolean(opts.open),
        dryRun: Boolean(opts.dryRun),
        json: Boolean(opts.json),
      };
      if (opts.repo) rawOpts.repo = opts.repo;
      if (opts.category) rawOpts.category = opts.category;
      if (opts.awesomeRepo) rawOpts.awesomeRepo = opts.awesomeRepo;
      parsedResult = CliDiscussOptionsSchema.parse(rawOpts);
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
    .option("--model <id>", "Primary Codex model for structuring findings (default: codex:<saved-or-flagship>)")
    .option("--judge-model <id>", "Codex model for Stage 4 blind baseline and judging (default: codex:<saved-or-flagship>)")
    .option("--reasoning <effort>", "Override Codex thinking effort (low|medium|high|xhigh|max|ultra)")
    .option("--judge-reasoning <effort>", "Override Codex judge thinking effort (low|medium|high|xhigh|max|ultra)")
    .option("--reconfigure", "Re-run interactive Codex setup before executing", false)
    .option("--max-budget <usd>", "Hard USD cap", "10.00")
    .option("--git-depth <n>", "Shallow clone depth for remote repositories", "150")
    .option("--min-novelty <1-5>", "Minimum novelty score (1-5) required to keep a pattern (default: 3)")
    .option("--skip-novelty", "Bypass Stage 4 (marks output unverified)", false)
    .option("--no-git", "Skip git metadata resolution")
    .option("--publish", "Publish compiled skill to the configured awesome repo (default: enabled)")
    .option("--publish-repo <repo>", "Override awesome repository (owner/repo or Git URL)")
    .option("--discuss", "Open a new GitHub Discussion with the distilled playbook")
    .option("--discuss-target <target>", "Discussion target repo (auto|source|awesome)")
    .option("--json", "Emit machine-readable report to stdout", false)
    .action((findingsFile: string, _opts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<Record<string, unknown>>();
      const modelExplicit = cmd.getOptionValueSource("model") === "cli";
      const judgeModelExplicit = cmd.getOptionValueSource("judgeModel") === "cli";
      const publishExplicit = cmd.getOptionValueSource("publish") === "cli";
      const rawOpts: Record<string, unknown> = {
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
      };
      if (publishExplicit) rawOpts.publish = Boolean(opts.publish);
      if (opts.publishRepo) rawOpts.publishRepo = opts.publishRepo;
      if (opts.discuss) rawOpts.discuss = true;
      if (opts.discussTarget) rawOpts.discussTarget = opts.discussTarget;
      parsedResult = CliFromFindingsOptionsSchema.parse(rawOpts);
    });

  program
    .argument("[source]", "Local path or Git URL (https://... or git@...)")
    .option("--out <dir>", "Output directory where <skill-slug>/ will be written", "./.claude/skills")
    .option("--name <slug>", "Override output skill folder name (kebab-case)")
    .option("--subpath <path>", "Restrict analysis to a package inside a monorepo", ".")
    .option("--model <id>", "Primary Codex model for Stage 3 Pattern Mining (default: codex:<saved-or-flagship>)")
    .option("--judge-model <id>", "Codex model for Stage 4 blind baseline and judging (default: codex:<saved-or-flagship>)")
    .option("--reasoning <effort>", "Override Codex thinking effort (low|medium|high|xhigh|max|ultra)")
    .option("--judge-reasoning <effort>", "Override Codex judge thinking effort (low|medium|high|xhigh|max|ultra)")
    .option("--reconfigure", "Re-run interactive Codex setup before executing", false)
    .option("--max-budget <usd>", "Hard USD cap", "10.00")
    .option("--max-files <n>", "Maximum source files included in SignalBundle", "40")
    .option("--max-commits <n>", "Maximum high-signal git diffs included in SignalBundle", "25")
    .option("--git-depth <n>", "Shallow clone depth for remote repositories", "150")
    .option("--min-novelty <1-5>", "Minimum novelty score (1-5) required to keep a pattern (default: 3)")
    .option("--skip-novelty", "Bypass Stage 4 (marks output unverified)", false)
    .option("--dry-run", "Run Stages 1 & 2 only; print SignalBundle stats and estimated USD cost", false)
    .option("--update", "Incrementally update an existing skill directory from git delta since lastCommitSha", false)
    .option("--no-git", "Skip git history mining for repositories without commit logs")
    .option("--publish", "Publish compiled skill to the configured awesome repo (default: enabled)")
    .option("--publish-repo <repo>", "Override awesome repository (owner/repo or Git URL)")
    .option("--discuss", "Open a new GitHub Discussion with the distilled playbook")
    .option("--discuss-target <target>", "Discussion target repo (auto|source|awesome)")
    .option("--json", "Emit machine-readable report to stdout", false)
    .action((source: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      const modelExplicit = cmd.getOptionValueSource("model") === "cli";
      const judgeModelExplicit = cmd.getOptionValueSource("judgeModel") === "cli";
      const publishExplicit = cmd.getOptionValueSource("publish") === "cli";
      const rawOpts: Record<string, unknown> = {
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
      };
      if (publishExplicit) rawOpts.publish = Boolean(opts.publish);
      if (opts.publishRepo) rawOpts.publishRepo = opts.publishRepo;
      if (opts.discuss) rawOpts.discuss = true;
      if (opts.discussTarget) rawOpts.discussTarget = opts.discussTarget;
      parsedResult = CliRepoOptionsSchema.parse(rawOpts);
    });

  program.parse(argv);
  if (!parsedResult) {
    throw new Error("No CLI command matched.");
  }
  return parsedResult;
}
