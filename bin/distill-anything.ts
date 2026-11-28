#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { CommanderError } from "commander";
import { ZodError } from "zod";
import { parseCliArgs, type CliOptions } from "../src/cli/args";
import { Reporter } from "../src/cli/reporter";
import { resolveNonTtyDefaults, runInteractiveSetup } from "../src/cli/setup";
import { BudgetExceededError, BudgetLedger } from "../src/core/budget";
import { CodexNotFoundError, discoverCodex, type CodexDiscoveryResult } from "../src/core/codex-discovery";
import { loadConfig, saveConfig, type DistillConfig, type ReasoningEffort } from "../src/core/config";
import { InvalidModelError, MissingApiKeyError, parseModelId, validateApiKeys } from "../src/core/llm";
import { ingestRepository, toKebabSlug, type IngestResult } from "../src/stages/01-ingest";
import { buildSignalBundle } from "../src/stages/02-signals/bundler";
import { GroundingFailureError, minePatterns, type MiningResult } from "../src/stages/03-miner/extract";
import { extractPatternsFromFindings } from "../src/stages/03-miner/from-findings";
import { runNoveltyGate } from "../src/stages/04-novelty/judge";
import { renderPatternFile } from "../src/stages/05-compiler/render-pattern";
import { renderSkillIndex } from "../src/stages/05-compiler/render-skill";
import { MergeInputError, mergeSkills } from "../src/stages/06-merge/synthesize";
import { formatOrgScanTable, scanOrganization } from "../src/stages/org-scan/scanner";
import {
  DEFAULT_AWESOME_REPO,
  PublishError,
  publishSkillToAwesomeRepo,
  resolvePublishSettings,
} from "../src/stages/publish/publisher";
import { DiscussError, openSkillDiscussion } from "../src/stages/publish/discuss";
import { runIncrementalUpdate } from "../src/stages/update/incremental";
import type { VerifiedPattern } from "../src/schemas/novelty";
import type { RepoProfile } from "../src/schemas/repo-profile";
import type { DistillReport, DroppedPatternLog, GroundingMode } from "../src/schemas/report";

function buildUngroundedProfile(findingsFile: string, nameOverride?: string): RepoProfile {
  const base = basename(findingsFile, extname(findingsFile));
  const skillSlug = nameOverride ?? toKebabSlug(base);
  return {
    source: "ungrounded_notes",
    repoName: nameOverride ?? base,
    skillSlug,
    commitSha: null,
    subpath: ".",
    analyzedAt: new Date().toISOString(),
    primaryLanguage: "typescript",
    languages: [{ language: "unknown", fileCount: 0, loc: 0, sharePercent: 100 }],
    totalFilesScanned: 0,
    skippedOversizedFiles: [],
    maturity: {
      classification: "hybrid",
      hasCiWorkflows: false,
      hasBenchmarks: false,
      hasStrictTyping: false,
      testToSourceRatio: 0,
      experimentalMarkersPerKloc: 0,
    },
  };
}

function toCodexModelId(modelName: string): string {
  return modelName.includes(":") ? modelName : `codex:${modelName}`;
}

function maybeOpenDiscussion(params: {
  skillDir: string;
  cliDiscuss?: boolean | undefined;
  cliTarget?: "auto" | "source" | "awesome" | undefined;
  awesomeRepo?: string | undefined;
  reporter: Reporter;
}): void {
  if (!params.cliDiscuss) return;
  try {
    const res = openSkillDiscussion({
      skillDir: params.skillDir,
      target: params.cliTarget ?? "auto",
      awesomeRepo: params.awesomeRepo,
    });
    params.reporter.info(`Opened GitHub Discussion -> ${res.url} (mentions: ${res.mentionedOwners.join(", ") || "none"})`);
  } catch (err) {
    params.reporter.warn(
      `Auto-discuss failed (local skill preserved): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function tryLoadConfig(reporter?: Reporter): DistillConfig | null {
  try {
    return loadConfig();
  } catch (err) {
    reporter?.warn(
      `Saved config is invalid (${err instanceof Error ? err.message : String(err)}); ignoring it.`,
    );
    return null;
  }
}

function maybeAutoPublish(params: {
  skillDir: string;
  cliPublish?: boolean | undefined;
  cliRepo?: string | undefined;
  reporter: Reporter;
}): void {
  const savedConfig = tryLoadConfig();
  const settings = resolvePublishSettings({
    cliPublish: params.cliPublish,
    cliRepo: params.cliRepo,
    config: savedConfig,
  });
  if (!settings.shouldPublish || !settings.repo) {
    if (params.cliPublish === true && !settings.repo) {
      params.reporter.warn(
        "Skipping publish: no publish repository configured. Run `distill-anything publish <skill-dir> --repo <owner/repo> --set-default`.",
      );
    }
    return;
  }

  try {
    params.reporter.info(`Publishing skill to ${settings.repo} (${settings.branch})...`);
    const res = publishSkillToAwesomeRepo({
      skillDir: params.skillDir,
      repo: settings.repo,
      branch: settings.branch,
    });
    if (res.status === "published") {
      params.reporter.info(
        `Published ${res.skillSlug} -> ${res.repo} (${res.commitSha?.slice(0, 7) ?? "pushed"})`,
      );
    } else if (res.status === "up_to_date") {
      params.reporter.info(`${res.skillSlug} is already up to date in ${res.repo}.`);
    }
  } catch (err) {
    params.reporter.warn(
      `Auto-publish failed (local skill preserved): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface ExecutionConfig {
  effectiveModel: string;
  effectiveJudgeModel: string;
  effectiveReasoning: ReasoningEffort | undefined;
  effectiveJudgeReasoning: ReasoningEffort | undefined;
  codexPath: string | undefined;
}

function publishAndDiscuss(params: {
  skillDir: string;
  publish?: boolean | undefined;
  publishRepo?: string | undefined;
  discuss?: boolean | undefined;
  discussTarget?: "auto" | "source" | "awesome" | undefined;
  reporter: Reporter;
}): void {
  maybeAutoPublish({
    skillDir: params.skillDir,
    cliPublish: params.publish,
    cliRepo: params.publishRepo,
    reporter: params.reporter,
  });
  maybeOpenDiscussion({
    skillDir: params.skillDir,
    cliDiscuss: params.discuss,
    cliTarget: params.discussTarget,
    awesomeRepo: params.publishRepo,
    reporter: params.reporter,
  });
}

async function handleConfigMode(reporter: Reporter, json: boolean): Promise<number> {
  let discovery: CodexDiscoveryResult;
  try {
    discovery = discoverCodex();
  } catch (err) {
    if (err instanceof CodexNotFoundError) {
      reporter.error(err.message);
      return 2;
    }
    throw err;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    reporter.error("`distill-anything config` requires an interactive terminal (TTY).");
    return 2;
  }

  const existing = loadConfig();
  const saved = await runInteractiveSetup(discovery, existing);
  if (json) {
    console.log(JSON.stringify(saved, null, 2));
  }
  return 0;
}

async function handleScanOrgMode(
  options: Extract<CliOptions, { mode: "scan-org" }>,
  reporter: Reporter,
): Promise<number> {
  try {
    const report = await scanOrganization({
      org: options.org,
      limit: options.limit,
      lang: options.lang,
      minStars: options.minStars,
      maxSizeMb: options.maxSizeMb,
      includeForks: options.includeForks,
      includeArchived: options.includeArchived,
      concurrency: options.concurrency,
      onWarn: (msg) => reporter.warn(msg),
      onInfo: (msg) => reporter.info(msg),
    });

    if (options.out) {
      const outPath = resolve(options.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(report, null, 2));
      reporter.info(`Saved OrgScanReport -> ${outPath}`);
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatOrgScanTable(report));
    }
    return 0;
  } catch (err) {
    reporter.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function handlePublishMode(
  options: Extract<CliOptions, { mode: "publish" }>,
  reporter: Reporter,
): number {
  const savedConfig = tryLoadConfig();
  const targetRepo =
    options.repo ?? process.env.DISTILL_PUBLISH_REPO?.trim() ?? savedConfig?.publishRepo ?? DEFAULT_AWESOME_REPO;
  const targetBranch =
    options.branch ?? process.env.DISTILL_PUBLISH_BRANCH?.trim() ?? savedConfig?.publishBranch ?? "main";

  try {
    const result = publishSkillToAwesomeRepo({
      skillDir: options.skillDir,
      repo: targetRepo,
      branch: targetBranch,
    });

    if (options.setDefault && savedConfig) {
      saveConfig({
        ...savedConfig,
        publishRepo: targetRepo,
        publishBranch: targetBranch,
        autoPublish: true,
        updatedAt: new Date().toISOString(),
      });
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === "published") {
      reporter.info(
        `Published ${result.skillSlug} (${result.patternsKept} patterns) -> ${result.repo} (${result.commitSha?.slice(0, 7) ?? "pushed"})`,
      );
    } else {
      reporter.info(`${result.skillSlug} is already up to date in ${result.repo}.`);
    }
    maybeOpenDiscussion({
      skillDir: options.skillDir,
      cliDiscuss: options.discuss,
      cliTarget: options.discussTarget,
      awesomeRepo: targetRepo,
      reporter,
    });
    return 0;
  } catch (err) {
    if (err instanceof PublishError || err instanceof ZodError) {
      reporter.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    throw err;
  }
}

function handleDiscussMode(
  options: Extract<CliOptions, { mode: "discuss" }>,
  reporter: Reporter,
): number {
  const savedConfig = tryLoadConfig();
  const awesomeRepo =
    options.awesomeRepo ?? process.env.DISTILL_PUBLISH_REPO?.trim() ?? savedConfig?.publishRepo ?? DEFAULT_AWESOME_REPO;
  try {
    const result = openSkillDiscussion({
      skillDir: options.skillDir,
      target: options.target,
      targetRepo: options.repo,
      category: options.category,
      awesomeRepo,
      dryRun: options.dryRun,
      openBrowser: options.open,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === "created") {
      reporter.info(`Opened GitHub Discussion #${result.discussionNumber ?? "?"} -> ${result.url}`);
    } else if (result.status === "browser_opened") {
      reporter.info(`Opened pre-filled New Discussion in browser -> ${result.url}`);
    } else {
      reporter.info(`[dry-run] Target: ${result.targetRepo} | Mentions: ${result.mentionedOwners.join(", ") || "none"}`);
      reporter.info(`[dry-run] Title: ${result.title}`);
      reporter.info(`[dry-run] URL: ${result.url}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof DiscussError || err instanceof PublishError || err instanceof ZodError) {
      reporter.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    throw err;
  }
}

async function resolveExecutionConfig(
  options: Extract<CliOptions, { mode: "merge" | "repo" | "from-findings" }>,
  reporter: Reporter,
): Promise<{ ok: true; exec: ExecutionConfig } | { ok: false; code: number }> {
  const isDryRun = options.mode === "repo" && options.dryRun;
  const exec: ExecutionConfig = {
    effectiveModel: options.model,
    effectiveJudgeModel: options.mode === "merge" ? options.model : options.judgeModel,
    effectiveReasoning: options.reasoning,
    effectiveJudgeReasoning: options.mode === "merge" ? undefined : options.judgeReasoning,
    codexPath: undefined,
  };
  if (isDryRun) return { ok: true, exec };

  let savedConfig = tryLoadConfig(reporter);
  const needsCodex =
    (options.mode !== "merge" && options.reconfigure) ||
    !options.modelExplicit ||
    options.model.startsWith("codex:") ||
    (options.mode !== "merge" &&
      !options.skipNovelty &&
      (!options.judgeModelExplicit || options.judgeModel.startsWith("codex:")));

  if (needsCodex) {
    let discovery: CodexDiscoveryResult;
    try {
      discovery = discoverCodex();
      exec.codexPath = discovery.codexPath;
    } catch (err) {
      if (err instanceof CodexNotFoundError) {
        reporter.error(err.message);
        return { ok: false, code: 2 };
      }
      throw err;
    }

    if ((options.mode !== "merge" && options.reconfigure) || (!savedConfig && !options.modelExplicit)) {
      if (process.stdin.isTTY && process.stdout.isTTY && !options.json) {
        savedConfig = await runInteractiveSetup(discovery, savedConfig);
      } else if (!savedConfig) {
        const defaults = resolveNonTtyDefaults(discovery);
        exec.effectiveModel = toCodexModelId(defaults.model);
        exec.effectiveReasoning = exec.effectiveReasoning ?? defaults.reasoningEffort;
        if (options.mode !== "merge" && !options.judgeModelExplicit) {
          exec.effectiveJudgeModel = toCodexModelId(defaults.judgeModel);
        }
        exec.effectiveJudgeReasoning = exec.effectiveJudgeReasoning ?? defaults.judgeReasoningEffort;
        console.error(
          `[distill-anything] No config file found and non-interactive mode detected; using latest Codex flagship defaults (model=${defaults.model}, reasoning=${exec.effectiveReasoning}). Run "distill-anything config" to customize.`,
        );
      }
    }

    if (savedConfig) {
      if (!options.modelExplicit) exec.effectiveModel = toCodexModelId(savedConfig.model);
      exec.effectiveReasoning = exec.effectiveReasoning ?? savedConfig.reasoningEffort;
      if (options.mode !== "merge" && !options.judgeModelExplicit) {
        exec.effectiveJudgeModel = toCodexModelId(savedConfig.judgeModel ?? savedConfig.model);
      }
      exec.effectiveJudgeReasoning = exec.effectiveJudgeReasoning ?? savedConfig.judgeReasoningEffort ?? "low";
      if (exec.effectiveModel.startsWith("codex:")) {
        const modelLabel = parseModelId(exec.effectiveModel).modelName;
        console.error(
          `[distill-anything] Using Codex CLI (${discovery.version}) · model=${modelLabel} · reasoning=${exec.effectiveReasoning}`,
        );
      }
    }
  }

  try {
    const modelsToCheck =
      options.mode === "merge" || options.skipNovelty
        ? [exec.effectiveModel]
        : [exec.effectiveModel, exec.effectiveJudgeModel];
    validateApiKeys(modelsToCheck);
  } catch (err) {
    if (err instanceof MissingApiKeyError || err instanceof InvalidModelError) {
      reporter.error(err.message);
      return { ok: false, code: 2 };
    }
    throw err;
  }

  return { ok: true, exec };
}

function writeMergedArtifacts(
  options: Extract<CliOptions, { mode: "merge" }>,
  merged: Awaited<ReturnType<typeof mergeSkills>>,
  exec: ExecutionConfig,
  budget: BudgetLedger,
): { outSkillDir: string; report: DistillReport } {
  const outSkillDir = resolve(options.out, options.name);
  const patternsDir = join(outSkillDir, "references/patterns");
  mkdirSync(patternsDir, { recursive: true });
  for (const p of merged.compiledPatterns) {
    writeFileSync(join(patternsDir, p.filename), p.markdown);
  }
  writeFileSync(join(outSkillDir, "SKILL.md"), merged.skillMd);

  const totalCandidates = merged.loadedSkills.reduce((s, sk) => s + sk.patterns.length, 0);
  const report: DistillReport = {
    version: "1.0",
    tool: "distill-anything",
    provider: parseModelId(exec.effectiveModel).provider,
    profile: {
      source: `merged:${merged.loadedSkills.map((s) => s.report.profile.skillSlug).join(",")}`,
      repoName: options.name,
      skillSlug: options.name,
      commitSha: null,
      subpath: ".",
      analyzedAt: new Date().toISOString(),
      primaryLanguage: merged.loadedSkills[0]?.report.profile.primaryLanguage ?? "unknown",
      languages: [{ language: "multi", fileCount: merged.compiledPatterns.length, loc: 0, sharePercent: 100 }],
      totalFilesScanned: merged.loadedSkills.length,
      skippedOversizedFiles: [],
      maturity: {
        classification: "production",
        hasCiWorkflows: true,
        hasBenchmarks: false,
        hasStrictTyping: true,
        testToSourceRatio: 1,
        experimentalMarkersPerKloc: 0,
      },
    },
    outputPath: outSkillDir,
    groundingMode: "verified_disk",
    totalCandidatesExtracted: totalCandidates,
    groundingFailures: 0,
    patternsKept: merged.compiledPatterns.length,
    patternsDropped: merged.droppedPatterns,
    mergedFrom: merged.loadedSkills.map((s) => ({
      skillSlug: s.report.profile.skillSlug,
      repoName: s.report.profile.repoName,
      source: s.report.profile.source,
      commitSha: s.report.profile.commitSha,
    })),
    costs: budget.getEntries(),
    totalCostUsd: Number(budget.getTotalCostUsd().toFixed(6)),
    skillIndexTokens: merged.skillIndexTokens,
  };
  writeFileSync(join(outSkillDir, "distill-report.json"), JSON.stringify(report, null, 2));
  return { outSkillDir, report };
}

async function handleMergeMode(
  options: Extract<CliOptions, { mode: "merge" }>,
  exec: ExecutionConfig,
  budget: BudgetLedger,
  reporter: Reporter,
): Promise<number> {
  try {
    reporter.info(`Merging skills into "${options.name}"...`);
    const merged = await mergeSkills({
      skillDirs: options.skillDirs,
      outputSlug: options.name,
      maxPatterns: options.maxPatterns,
      modelId: exec.effectiveModel,
      reasoningEffort: exec.effectiveReasoning,
      codexPath: exec.codexPath,
      budget,
    });
    const { outSkillDir, report } = writeMergedArtifacts(options, merged, exec, budget);
    reporter.printReport(report);
    publishAndDiscuss({
      skillDir: outSkillDir,
      publish: options.publish,
      publishRepo: options.publishRepo,
      discuss: options.discuss,
      discussTarget: options.discussTarget,
      reporter,
    });
    return 0;
  } catch (err) {
    if (err instanceof MergeInputError) {
      reporter.error(err.message);
      return 2;
    }
    if (err instanceof BudgetExceededError) {
      reporter.error(err.message);
      return 3;
    }
    reporter.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function runRepoIncrementalUpdate(
  options: Extract<CliOptions, { mode: "repo" }>,
  ingest: IngestResult,
  exec: ExecutionConfig,
  budget: BudgetLedger,
  reporter: Reporter,
): Promise<number | null> {
  if (!options.update || options.dryRun) return null;
  const inc = await runIncrementalUpdate({
    repoRoot: ingest.repoRoot,
    analysisRoot: ingest.analysisRoot,
    outDir: options.out,
    skillSlug: ingest.profile.skillSlug,
    headSha: ingest.profile.commitSha,
    modelId: exec.effectiveModel,
    judgeModelId: exec.effectiveJudgeModel,
    reasoningEffort: exec.effectiveReasoning,
    judgeReasoningEffort: exec.effectiveJudgeReasoning,
    codexPath: exec.codexPath,
    budget,
    minNovelty: options.minNovelty,
    skipNovelty: options.skipNovelty,
  });

  if (inc.status === "up_to_date") {
    reporter.info(`No new commits since ${inc.headSha.slice(0, 8)}.`);
    return 0;
  }
  if (inc.status === "docs_only") {
    reporter.info(
      `Only docs/CI/lockfiles changed (${inc.fromSha.slice(0, 8)}..${inc.toSha.slice(0, 8)}); updated lastCommitSha with zero LLM calls.`,
    );
    if (options.json) console.log(JSON.stringify(inc.report, null, 2));
    return 0;
  }
  if (inc.status === "updated") {
    reporter.info(
      `Incremental update complete (${inc.fromSha.slice(0, 8)}..${inc.toSha.slice(0, 8)}): promoted=${inc.promoted}, added=${inc.added}, deprecated=${inc.deprecated}`,
    );
    reporter.printReport(inc.report);
    publishAndDiscuss({
      skillDir: resolve(options.out, ingest.profile.skillSlug),
      publish: options.publish,
      publishRepo: options.publishRepo,
      discuss: options.discuss,
      discussTarget: options.discussTarget,
      reporter,
    });
    return 0;
  }
  reporter.warn(`${inc.reason}; falling back to full distillation run.`);
  return null;
}

async function runNoveltyFilter(params: {
  mined: MiningResult;
  primaryLanguage: string;
  groundingMode: GroundingMode;
  options: Extract<CliOptions, { mode: "repo" | "from-findings" }>;
  exec: ExecutionConfig;
  budget: BudgetLedger;
  reporter: Reporter;
}): Promise<{ kept: VerifiedPattern[]; dropped: DroppedPatternLog[] }> {
  if (params.options.skipNovelty) {
    params.reporter.warn("Skipping Stage 4 Novelty Gate (--skip-novelty). Output marked unverified.");
    const kept = params.mined.groundedPatterns.map((p) => ({
      pattern: p,
      groundingVerified: params.groundingMode === "verified_disk",
      blindBaselineSummary: "Skipped via --skip-novelty",
      audit: {
        noveltyScore: 4,
        transferabilityScore: 4,
        antiTriggerQuality: "adequate" as const,
        verdict: "keep" as const,
        reasoning: "Novelty gate bypassed via --skip-novelty.",
      },
    }));
    return { kept, dropped: [...params.mined.droppedByGrounder] };
  }

  params.reporter.info(
    `Running Novelty Gate across ${params.mined.groundedPatterns.length} patterns (min-novelty=${params.options.minNovelty})...`,
  );
  const novelty = await runNoveltyGate({
    patterns: params.mined.groundedPatterns,
    primaryLanguage: params.primaryLanguage,
    judgeModelId: params.exec.effectiveJudgeModel,
    judgeReasoningEffort: params.exec.effectiveJudgeReasoning,
    codexPath: params.exec.codexPath,
    budget: params.budget,
    minNovelty: params.options.minNovelty,
  });
  return {
    kept: novelty.kept,
    dropped: [...params.mined.droppedByGrounder, ...novelty.dropped],
  };
}

function writeDistillReport(params: {
  outSkillDir: string;
  providerName: string;
  profile: RepoProfile;
  groundingMode: GroundingMode;
  minNovelty: number;
  mined: MiningResult;
  patternsKept: number;
  dropped: DroppedPatternLog[];
  budget: BudgetLedger;
  skillIndexTokens: number;
  partialOverlapPatterns?: DistillReport["partialOverlapPatterns"];
}): DistillReport {
  const report: DistillReport = {
    version: "1.0",
    tool: "distill-anything",
    provider: params.providerName,
    profile: params.profile,
    outputPath: params.outSkillDir,
    groundingMode: params.groundingMode,
    minNovelty: params.minNovelty,
    totalCandidatesExtracted: params.mined.totalCandidatesExtracted,
    groundingFailures: params.mined.groundingFailures,
    patternsKept: params.patternsKept,
    patternsDropped: params.dropped,
    costs: params.budget.getEntries(),
    totalCostUsd: Number(params.budget.getTotalCostUsd().toFixed(6)),
    skillIndexTokens: params.skillIndexTokens,
  };
  if (params.partialOverlapPatterns && params.partialOverlapPatterns.length > 0) {
    report.partialOverlapPatterns = params.partialOverlapPatterns;
  }
  writeFileSync(join(params.outSkillDir, "distill-report.json"), JSON.stringify(report, null, 2));
  return report;
}

type MiningStageResult =
  | { earlyExitCode: number; ingest: IngestResult | undefined }
  | {
      earlyExitCode?: undefined;
      ingest: IngestResult | undefined;
      profile: RepoProfile;
      mined: MiningResult;
      groundingMode: GroundingMode;
    };

async function runRepoOrFindingsMining(
  options: Extract<CliOptions, { mode: "repo" | "from-findings" }>,
  exec: ExecutionConfig,
  budget: BudgetLedger,
  reporter: Reporter,
): Promise<MiningStageResult> {
  if (options.mode === "repo") {
    reporter.info(`Ingesting ${options.source}...`);
    const ingest = await ingestRepository({
      source: options.source,
      subpath: options.subpath,
      gitDepth: options.gitDepth,
      noGit: options.noGit,
      nameOverride: options.name,
    });
    if (!ingest.isGitRepo) {
      reporter.warn("Git history unavailable or --no-git specified; running in degraded mode without commit mining.");
    }
    const incCode = await runRepoIncrementalUpdate(options, ingest, exec, budget, reporter);
    if (incCode !== null) {
      return { ingest, earlyExitCode: incCode };
    }
    reporter.info("Extracting deterministic signals (AST + Git + Tests)...");
    const bundle = await buildSignalBundle({
      ingest,
      maxFiles: options.maxFiles,
      maxCommits: options.maxCommits,
      gitDepth: options.gitDepth,
    });
    if (options.dryRun) {
      reporter.printDryRun(bundle, exec.effectiveModel, budget);
      return { ingest, earlyExitCode: 0 };
    }
    reporter.info(`Mining patterns with ${exec.effectiveModel}...`);
    const mined = await minePatterns({
      bundle,
      analysisRoot: ingest.analysisRoot,
      modelId: exec.effectiveModel,
      reasoningEffort: exec.effectiveReasoning,
      codexPath: exec.codexPath,
      budget,
    });
    return { ingest, profile: bundle.profile, mined, groundingMode: "verified_disk" };
  }

  const ingest = options.repo
    ? (reporter.info(`Resolving repository ${options.repo} for grounding...`),
      await ingestRepository({
        source: options.repo,
        subpath: options.subpath,
        gitDepth: options.gitDepth,
        noGit: options.noGit,
        nameOverride: options.name,
      }))
    : undefined;
  const profile = ingest ? ingest.profile : buildUngroundedProfile(options.findingsFile, options.name);
  const groundingMode: GroundingMode = options.allowUngrounded ? "ungrounded_notes" : "verified_disk";
  if (groundingMode === "ungrounded_notes") {
    reporter.warn("Running in --allow-ungrounded mode; citations are not verified against disk.");
  }
  reporter.info(`Structuring findings from ${options.findingsFile} with ${exec.effectiveModel}...`);
  const mined = await extractPatternsFromFindings({
    findingsFile: options.findingsFile,
    repoName: profile.repoName,
    primaryLanguage: profile.primaryLanguage,
    analysisRoot: ingest?.analysisRoot,
    allowUngrounded: options.allowUngrounded,
    modelId: exec.effectiveModel,
    reasoningEffort: exec.effectiveReasoning,
    codexPath: exec.codexPath,
    budget,
  });
  return { ingest, profile, mined, groundingMode };
}

function compileAndWriteSkill(params: {
  outSkillDir: string;
  providerName: string;
  profile: RepoProfile;
  groundingMode: GroundingMode;
  options: Extract<CliOptions, { mode: "repo" | "from-findings" }>;
  mined: MiningResult;
  kept: VerifiedPattern[];
  dropped: DroppedPatternLog[];
  budget: BudgetLedger;
}): DistillReport {
  const patternsDir = join(params.outSkillDir, "references/patterns");
  mkdirSync(patternsDir, { recursive: true });
  params.kept.forEach((vp, idx) => {
    const filename = `${String(idx + 1).padStart(2, "0")}-${vp.pattern.id}.md`;
    const { markdown } = renderPatternFile(vp, params.profile.primaryLanguage);
    writeFileSync(join(patternsDir, filename), markdown);
  });

  const { markdown: skillMd, tokenCount: skillIndexTokens } = renderSkillIndex({
    profile: params.profile,
    operatingConstraints: params.mined.operatingConstraints,
    patterns: params.kept,
    unverified: params.options.skipNovelty,
    groundingMode: params.groundingMode,
  });
  writeFileSync(join(params.outSkillDir, "SKILL.md"), skillMd);

  const partialOverlapPatterns = params.kept
    .filter((vp) => vp.audit.noveltyScore === 3)
    .map((vp) => ({
      patternId: vp.pattern.id,
      title: vp.pattern.title,
      noveltyScore: vp.audit.noveltyScore,
      note: "Partial Baseline Overlap (3/5) — retained under min-novelty=3; verify value against your target model",
    }));

  return writeDistillReport({
    outSkillDir: params.outSkillDir,
    providerName: params.providerName,
    profile: params.profile,
    groundingMode: params.groundingMode,
    minNovelty: params.options.minNovelty,
    mined: params.mined,
    patternsKept: params.kept.length,
    dropped: params.dropped,
    budget: params.budget,
    skillIndexTokens,
    partialOverlapPatterns,
  });
}

async function handleDistillMode(
  options: Extract<CliOptions, { mode: "repo" | "from-findings" }>,
  exec: ExecutionConfig,
  budget: BudgetLedger,
  reporter: Reporter,
): Promise<number> {
  let ingest: IngestResult | undefined;

  try {
    const stage = await runRepoOrFindingsMining(options, exec, budget, reporter);
    ingest = stage.ingest;
    if (stage.earlyExitCode !== undefined) return stage.earlyExitCode;

    const { kept, dropped } = await runNoveltyFilter({
      mined: stage.mined,
      primaryLanguage: stage.profile.primaryLanguage,
      groundingMode: stage.groundingMode,
      options,
      exec,
      budget,
      reporter,
    });

    const outSkillDir = resolve(options.out, stage.profile.skillSlug);
    mkdirSync(outSkillDir, { recursive: true });
    const providerName = parseModelId(exec.effectiveModel).provider;

    if (kept.length === 0) {
      writeDistillReport({
        outSkillDir,
        providerName,
        profile: stage.profile,
        groundingMode: stage.groundingMode,
        minNovelty: options.minNovelty,
        mined: stage.mined,
        patternsKept: 0,
        dropped,
        budget,
        skillIndexTokens: 0,
      });
      reporter.error("Zero patterns survived the Novelty Gate. Wrote distill-report.json.");
      return 4;
    }

    const report = compileAndWriteSkill({
      outSkillDir,
      providerName,
      profile: stage.profile,
      groundingMode: stage.groundingMode,
      options,
      mined: stage.mined,
      kept,
      dropped,
      budget,
    });

    reporter.printReport(report);
    publishAndDiscuss({
      skillDir: outSkillDir,
      publish: options.publish,
      publishRepo: options.publishRepo,
      discuss: options.discuss,
      discussTarget: options.discussTarget,
      reporter,
    });
    return 0;
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      reporter.error(err.message);
      return 3;
    }
    if (err instanceof GroundingFailureError) {
      reporter.error(err.message);
      return 5;
    }
    reporter.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    ingest?.cleanup();
  }
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv);
  } catch (err) {
    if (err instanceof CommanderError && err.exitCode === 0) return 0;
    console.error(
      `[error] Invalid arguments: ${
        err instanceof ZodError
          ? err.issues.map((i) => i.message).join("; ")
          : err instanceof Error
            ? err.message
            : String(err)
      }`,
    );
    return 2;
  }

  const reporter = new Reporter(options.json);

  if (options.mode === "config") return handleConfigMode(reporter, options.json);
  if (options.mode === "scan-org") return handleScanOrgMode(options, reporter);
  if (options.mode === "publish") return handlePublishMode(options, reporter);
  if (options.mode === "discuss") return handleDiscussMode(options, reporter);

  const resolved = await resolveExecutionConfig(options, reporter);
  if (!resolved.ok) return resolved.code;

  const budget = new BudgetLedger(options.maxBudget);
  if (options.mode === "merge") return handleMergeMode(options, resolved.exec, budget, reporter);
  return handleDistillMode(options, resolved.exec, budget, reporter);
}

const code = await main();
process.exit(code);
