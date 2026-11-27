#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { CommanderError } from "commander";
import { ZodError } from "zod";
import { parseCliArgs, type CliOptions } from "../src/cli/args";
import { Reporter } from "../src/cli/reporter";
import { resolveNonTtyDefaults, runInteractiveSetup } from "../src/cli/setup";
import { BudgetExceededError, BudgetLedger } from "../src/core/budget";
import { CodexNotFoundError, discoverCodex, type CodexDiscoveryResult } from "../src/core/codex-discovery";
import { loadConfig, type DistillConfig, type ReasoningEffort } from "../src/core/config";
import { InvalidModelError, MissingApiKeyError, parseModelId, validateApiKeys } from "../src/core/llm";
import { ingestRepository, toKebabSlug, type IngestResult } from "../src/stages/01-ingest";
import { buildSignalBundle } from "../src/stages/02-signals/bundler";
import { GroundingFailureError, minePatterns, type MiningResult } from "../src/stages/03-miner/extract";
import { extractPatternsFromFindings } from "../src/stages/03-miner/from-findings";
import { runNoveltyGate } from "../src/stages/04-novelty/judge";
import { renderPatternFile } from "../src/stages/05-compiler/render-pattern";
import { renderSkillIndex } from "../src/stages/05-compiler/render-skill";
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

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv);
  } catch (err) {
    if (err instanceof CommanderError && err.exitCode === 0) {
      return 0;
    }
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

  if (options.mode === "config") {
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
    if (options.json) {
      console.log(JSON.stringify(saved, null, 2));
    }
    return 0;
  }

  const budget = new BudgetLedger(options.maxBudget);
  const isDryRun = options.mode === "repo" && options.dryRun;

  let effectiveModel = options.model;
  let effectiveJudgeModel = options.judgeModel;
  let effectiveReasoning: ReasoningEffort | undefined = options.reasoning;
  let effectiveJudgeReasoning: ReasoningEffort | undefined = options.judgeReasoning;
  let codexPath: string | undefined;

  if (!isDryRun) {
    let savedConfig: DistillConfig | null = null;
    try {
      savedConfig = loadConfig();
    } catch (err) {
      reporter.warn(
        `Saved config is invalid (${err instanceof Error ? err.message : String(err)}); ignoring it.`,
      );
      savedConfig = null;
    }

    const needsCodex =
      options.reconfigure ||
      !options.modelExplicit ||
      options.model.startsWith("codex:") ||
      (!options.skipNovelty && (!options.judgeModelExplicit || options.judgeModel.startsWith("codex:")));

    if (needsCodex) {
      let discovery: CodexDiscoveryResult;
      try {
        discovery = discoverCodex();
        codexPath = discovery.codexPath;
      } catch (err) {
        if (err instanceof CodexNotFoundError) {
          reporter.error(err.message);
          return 2;
        }
        throw err;
      }

      if (options.reconfigure || (!savedConfig && !options.modelExplicit)) {
        if (process.stdin.isTTY && process.stdout.isTTY && !options.json) {
          savedConfig = await runInteractiveSetup(discovery, savedConfig);
        } else if (!savedConfig) {
          const defaults = resolveNonTtyDefaults();
          effectiveModel = toCodexModelId(defaults.model);
          effectiveReasoning = effectiveReasoning ?? defaults.reasoningEffort;
          if (!options.judgeModelExplicit) {
            effectiveJudgeModel = toCodexModelId(defaults.judgeModel);
          }
          effectiveJudgeReasoning = effectiveJudgeReasoning ?? defaults.judgeReasoningEffort;
          console.error(
            `[distill-anything] No config file found and non-interactive mode detected; using defaults (model=${defaults.model}, reasoning=${effectiveReasoning}). Run "distill-anything config" to customize.`,
          );
        }
      }

      if (savedConfig) {
        if (!options.modelExplicit) {
          effectiveModel = toCodexModelId(savedConfig.model);
        }
        effectiveReasoning = effectiveReasoning ?? savedConfig.reasoningEffort;

        if (!options.judgeModelExplicit) {
          effectiveJudgeModel = toCodexModelId(savedConfig.judgeModel ?? savedConfig.model);
        }
        effectiveJudgeReasoning =
          effectiveJudgeReasoning ?? savedConfig.judgeReasoningEffort ?? "low";

        if (effectiveModel.startsWith("codex:")) {
          const modelLabel = parseModelId(effectiveModel).modelName;
          console.error(
            `[distill-anything] Using Codex CLI (${discovery.version}) · model=${modelLabel} · reasoning=${effectiveReasoning}`,
          );
        }
      }
    }

    try {
      const modelsToCheck = options.skipNovelty
        ? [effectiveModel]
        : [effectiveModel, effectiveJudgeModel];
      validateApiKeys(modelsToCheck);
    } catch (err) {
      if (err instanceof MissingApiKeyError || err instanceof InvalidModelError) {
        reporter.error(err.message);
        return 2;
      }
      throw err;
    }
  }

  let ingest: IngestResult | undefined;

  try {
    let profile: RepoProfile;
    let mined: MiningResult;
    let groundingMode: GroundingMode = "verified_disk";

    if (options.mode === "repo") {
      reporter.info(`Ingesting ${options.source}...`);
      ingest = await ingestRepository({
        source: options.source,
        subpath: options.subpath,
        gitDepth: options.gitDepth,
        noGit: options.noGit,
        nameOverride: options.name,
      });

      if (!ingest.isGitRepo) {
        reporter.warn("Git history unavailable or --no-git specified; running in degraded mode without commit mining.");
      }

      reporter.info("Extracting deterministic signals (AST + Git + Tests)...");
      const bundle = await buildSignalBundle({
        ingest,
        maxFiles: options.maxFiles,
        maxCommits: options.maxCommits,
        gitDepth: options.gitDepth,
      });

      if (options.dryRun) {
        reporter.printDryRun(bundle, effectiveModel, budget);
        return 0;
      }

      profile = bundle.profile;
      reporter.info(`Mining patterns with ${effectiveModel}...`);
      mined = await minePatterns({
        bundle,
        analysisRoot: ingest.analysisRoot,
        modelId: effectiveModel,
        reasoningEffort: effectiveReasoning,
        codexPath,
        budget,
      });
    } else {
      if (options.repo) {
        reporter.info(`Resolving repository ${options.repo} for grounding...`);
        ingest = await ingestRepository({
          source: options.repo,
          subpath: options.subpath,
          gitDepth: options.gitDepth,
          noGit: options.noGit,
          nameOverride: options.name,
        });
        profile = ingest.profile;
      } else {
        profile = buildUngroundedProfile(options.findingsFile, options.name);
      }

      groundingMode = options.allowUngrounded ? "ungrounded_notes" : "verified_disk";
      if (groundingMode === "ungrounded_notes") {
        reporter.warn("Running in --allow-ungrounded mode; citations are not verified against disk.");
      }

      reporter.info(`Structuring findings from ${options.findingsFile} with ${effectiveModel}...`);
      mined = await extractPatternsFromFindings({
        findingsFile: options.findingsFile,
        repoName: profile.repoName,
        primaryLanguage: profile.primaryLanguage,
        analysisRoot: ingest?.analysisRoot,
        allowUngrounded: options.allowUngrounded,
        modelId: effectiveModel,
        reasoningEffort: effectiveReasoning,
        codexPath,
        budget,
      });
    }

    let kept: VerifiedPattern[];
    let dropped: DroppedPatternLog[] = [...mined.droppedByGrounder];

    if (options.skipNovelty) {
      reporter.warn("Skipping Stage 4 Novelty Gate (--skip-novelty). Output marked unverified.");
      kept = mined.groundedPatterns.map((p) => ({
        pattern: p,
        groundingVerified: groundingMode === "verified_disk",
        blindBaselineSummary: "Skipped via --skip-novelty",
        audit: {
          noveltyScore: 4,
          transferabilityScore: 4,
          antiTriggerQuality: "adequate",
          verdict: "keep",
          reasoning: "Novelty gate bypassed via --skip-novelty.",
        },
      }));
    } else {
      reporter.info(`Running Novelty Gate across ${mined.groundedPatterns.length} patterns (min-novelty=${options.minNovelty})...`);
      const novelty = await runNoveltyGate({
        patterns: mined.groundedPatterns,
        primaryLanguage: profile.primaryLanguage,
        judgeModelId: effectiveJudgeModel,
        judgeReasoningEffort: effectiveJudgeReasoning,
        codexPath,
        budget,
        minNovelty: options.minNovelty,
      });
      kept = novelty.kept;
      dropped = [...dropped, ...novelty.dropped];
    }

    const outSkillDir = resolve(options.out, profile.skillSlug);
    mkdirSync(outSkillDir, { recursive: true });
    const providerName = parseModelId(effectiveModel).provider;

    if (kept.length === 0) {
      const report: DistillReport = {
        version: "1.0",
        tool: "distill-anything",
        provider: providerName,
        profile,
        outputPath: outSkillDir,
        groundingMode,
        minNovelty: options.minNovelty,
        totalCandidatesExtracted: mined.totalCandidatesExtracted,
        groundingFailures: mined.groundingFailures,
        patternsKept: 0,
        patternsDropped: dropped,
        costs: budget.getEntries(),
        totalCostUsd: Number(budget.getTotalCostUsd().toFixed(6)),
        skillIndexTokens: 0,
      };
      writeFileSync(join(outSkillDir, "distill-report.json"), JSON.stringify(report, null, 2));
      reporter.error("Zero patterns survived the Novelty Gate. Wrote distill-report.json.");
      return 4;
    }

    const patternsDir = join(outSkillDir, "references/patterns");
    mkdirSync(patternsDir, { recursive: true });

    kept.forEach((vp, idx) => {
      const num = String(idx + 1).padStart(2, "0");
      const filename = `${num}-${vp.pattern.id}.md`;
      const { markdown } = renderPatternFile(vp, profile.primaryLanguage);
      writeFileSync(join(patternsDir, filename), markdown);
    });

    const { markdown: skillMd, tokenCount: skillIndexTokens } = renderSkillIndex({
      profile,
      operatingConstraints: mined.operatingConstraints,
      patterns: kept,
      unverified: options.skipNovelty,
      groundingMode,
    });
    writeFileSync(join(outSkillDir, "SKILL.md"), skillMd);

    const partialOverlapPatterns = kept
      .filter((vp) => vp.audit.noveltyScore === 3)
      .map((vp) => ({
        patternId: vp.pattern.id,
        title: vp.pattern.title,
        noveltyScore: vp.audit.noveltyScore,
        note: "Partial Baseline Overlap (3/5) — retained under min-novelty=3; verify value against your target model",
      }));

    const report: DistillReport = {
      version: "1.0",
      tool: "distill-anything",
      provider: providerName,
      profile,
      outputPath: outSkillDir,
      groundingMode,
      minNovelty: options.minNovelty,
      totalCandidatesExtracted: mined.totalCandidatesExtracted,
      groundingFailures: mined.groundingFailures,
      patternsKept: kept.length,
      patternsDropped: dropped,
      ...(partialOverlapPatterns.length > 0 ? { partialOverlapPatterns } : {}),
      costs: budget.getEntries(),
      totalCostUsd: Number(budget.getTotalCostUsd().toFixed(6)),
      skillIndexTokens,
    };
    writeFileSync(join(outSkillDir, "distill-report.json"), JSON.stringify(report, null, 2));

    reporter.printReport(report);
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

const code = await main();
process.exit(code);
