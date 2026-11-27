import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import type { BudgetLedger } from "../../core/budget";
import type { ReasoningEffort } from "../../core/config";
import { callStructuredLlm } from "../../core/llm";
import { loadPromptTemplate, renderTemplate } from "../../core/prompts";
import { countTokens, formatNumberedLines, truncateToTokens } from "../../core/tokens";
import { CandidatePatternSchema, type CandidatePattern } from "../../schemas/pattern";
import type { VerifiedPattern } from "../../schemas/novelty";
import type { RepoProfile } from "../../schemas/repo-profile";
import { DistillReportSchema, type DistillReport, type UpdateHistoryEntry } from "../../schemas/report";
import { groundCandidatePatterns } from "../03-miner/grounder";
import { runNoveltyGate } from "../04-novelty/judge";
import { renderPatternFile } from "../05-compiler/render-pattern";
import { renderSkillIndex } from "../05-compiler/render-skill";

const DELTA_TOKEN_CAP = 30_000;

export const IncrementalPromotionSchema = z.object({
  patternId: z.string().min(1),
  reason: z.string().min(1),
  updatedCitation: z
    .object({
      filePath: z.string().min(1),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      verbatimSnippet: z.string().min(20).max(2500),
    })
    .optional(),
});

export const IncrementalDeprecationSchema = z.object({
  patternId: z.string().min(1),
  reason: z.string().min(1),
  replacementPattern: CandidatePatternSchema.optional(),
});

export const IncrementalUpdateOutputSchema = z.object({
  promotions: z.array(IncrementalPromotionSchema).default([]),
  deprecations: z.array(IncrementalDeprecationSchema).default([]),
  additions: z.array(CandidatePatternSchema).default([]),
});

export type IncrementalUpdateOutput = z.infer<typeof IncrementalUpdateOutputSchema>;

const NON_SOURCE_EXTS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".lock",
  ".json",
  ".yaml",
  ".yml",
]);

const NON_SOURCE_FILES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "LICENSE",
  "CHANGELOG.md",
  ".gitignore",
  ".editorconfig",
]);

/** Returns true if a changed path is docs, CI, lockfile, or non-source asset. */
export function isNonSourceDeltaFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  const base = basename(norm);
  if (NON_SOURCE_FILES.has(base)) return true;
  if (
    norm.startsWith(".github/") ||
    norm.startsWith("docs/") ||
    norm === ".gitlab-ci.yml" ||
    /^changelog/i.test(base) ||
    /^readme/i.test(base)
  ) {
    return true;
  }
  const ext = extname(base).toLowerCase();
  return NON_SOURCE_EXTS.has(ext);
}

function runGitSync(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
  });
  return {
    ok: proc.exitCode === 0,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

export interface GitDeltaSummary {
  gitLog: string;
  diffStat: string;
  changedFiles: string[];
  changedSourceFiles: string[];
  boundedDelta: string;
  deltaTokens: number;
}

/** Computes git log, changed source files, and a <=30k-token bounded delta since fromSha. */
export function computeGitDelta(repoRoot: string, fromSha: string, toSha = "HEAD"): GitDeltaSummary {
  const logRes = runGitSync(["log", "--oneline", `${fromSha}..${toSha}`], repoRoot);
  const statRes = runGitSync(["diff", "--stat", `${fromSha}..${toSha}`], repoRoot);
  const namesRes = runGitSync(["diff", "--name-only", `${fromSha}..${toSha}`], repoRoot);

  const changedFiles = namesRes.ok && namesRes.stdout
    ? namesRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  const changedSourceFiles = changedFiles.filter((f) => !isNonSourceDeltaFile(f));

  const chunks: string[] = [];
  if (statRes.ok && statRes.stdout) {
    chunks.push("## Diff Stat\n" + statRes.stdout);
  }

  for (const relPath of changedSourceFiles) {
    const diffRes = runGitSync(["diff", `${fromSha}..${toSha}`, "--", relPath], repoRoot);
    if (diffRes.ok && diffRes.stdout) {
      chunks.push(`\n### Diff: ${relPath}\n\`\`\`diff\n${diffRes.stdout}\n\`\`\``);
    }
    const absPath = join(repoRoot, relPath);
    if (existsSync(absPath)) {
      try {
        const content = readFileSync(absPath, "utf8");
        chunks.push(`\n### Current Source (${relPath})\n${formatNumberedLines(content)}`);
      } catch {
        // ignore unreadable file
      }
    }
  }

  const rawDelta = chunks.join("\n");
  const { text: boundedDelta } = truncateToTokens(rawDelta, DELTA_TOKEN_CAP);
  return {
    gitLog: logRes.ok ? logRes.stdout : "",
    diffStat: statRes.ok ? statRes.stdout : "",
    changedFiles,
    changedSourceFiles,
    boundedDelta,
    deltaTokens: countTokens(boundedDelta),
  };
}

export interface ExistingPatternRecord {
  filename: string;
  patternId: string;
  title: string;
  maturityTag: "production_proven" | "experimental_technique";
  citedFiles: string[];
  rawMarkdown: string;
  verifiedPattern: VerifiedPattern;
}

function loadExistingPatterns(patternsDir: string): ExistingPatternRecord[] {
  if (!existsSync(patternsDir)) return [];
  const files = readdirSync(patternsDir).filter((f) => f.endsWith(".md")).sort();
  const records: ExistingPatternRecord[] = [];

  for (const filename of files) {
    const rawMarkdown = readFileSync(join(patternsDir, filename), "utf8");
    const patternId = basename(filename, ".md").replace(/^\d+-/, "");
    const title = rawMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? patternId;
    const categoryRaw = rawMarkdown.match(/^-\s+\*\*Category\*\*:\s+`([^`]+)`/m)?.[1] ?? "architecture";
    const maturityRaw = rawMarkdown.match(/^-\s+\*\*Maturity\*\*:\s+`([^`]+)`/m)?.[1];
    const maturityTag = maturityRaw === "experimental_technique" ? "experimental_technique" : "production_proven";
    const evidenceRaw = rawMarkdown.match(/^-\s+\*\*Evidence\*\*:\s+`([^`]+)`/m)?.[1];
    const evidenceStatus = evidenceRaw === "inferred_from_code" ? "inferred_from_code" : "seen_explicit";
    const auditMatch = rawMarkdown.match(/^-\s+\*\*Novelty Audit\*\*:\s+`(\d+)\/5`\s+\(Transferability:\s+`(\d+)\/5`\)/m);
    const noveltyScore = auditMatch?.[1] ? Number(auditMatch[1]) : 4;
    const transferabilityScore = auditMatch?.[2] ? Number(auditMatch[2]) : 4;

    const citedFiles: string[] = [];
    const citations: CandidatePattern["citations"] = [];
    const citRe = /\*\*`([^`]+)`\s+\(Lines\s+(\d+)[–-](\d+)\)\*\*(?:\s+·\s+Commit\s+`([^`]+)`)?[^\n]*\n```[^\n]*\n([\s\S]*?)\n```/g;
    for (const m of rawMarkdown.matchAll(citRe)) {
      const fp = m[1]?.trim();
      if (!fp) continue;
      citedFiles.push(fp);
      citations.push({
        filePath: fp,
        startLine: Number(m[2]) || 1,
        endLine: Number(m[3]) || 1,
        ...(m[4]?.trim() ? { commitSha: m[4].trim() } : {}),
        verbatimSnippet: m[5] ?? "code",
      });
    }

    const section = (h: string) => {
      const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return rawMarkdown.match(new RegExp(`^## ${esc}\\s*\\n([\\s\\S]*?)(?=^## |\\Z)`, "m"))?.[1]?.trim() ?? "";
    };
    const bullets = (s: string) =>
      s.split("\n").map((l) => l.trim()).filter((l) => /^[*|-]\s+/.test(l)).map((l) => l.replace(/^[*|-]\s+/, "").trim());

    const repoApproach = section("Repository Pattern") || title;
    const vp: VerifiedPattern = {
      pattern: {
        id: patternId,
        title,
        category: categoryRaw as CandidatePattern["category"],
        maturityTag,
        evidenceStatus,
        problemStatement: section("Problem") || title,
        naiveApproach: section("Default Approach (And Why It Breaks)") || "Standard approach.",
        repoApproach,
        transferableRule: repoApproach.split(/(?<=[.!?])\s+/)[0] || title,
        tradeOffs: bullets(section("Trade-Offs")).length > 0 ? bullets(section("Trade-Offs")) : ["Trade-off noted."],
        whenToApply: bullets(section("When to Apply")).length > 0 ? bullets(section("When to Apply")) : ["When applicable."],
        antiTriggers: bullets(section("Anti-Triggers (Do NOT Apply When)")).length > 0 ? bullets(section("Anti-Triggers (Do NOT Apply When)")) : ["Trivial scripts."],
        citations: citations.length > 0 ? citations : [{ filePath: "src/index.ts", startLine: 1, endLine: 1, verbatimSnippet: "placeholder" }],
      },
      groundingVerified: true,
      blindBaselineSummary: "Preserved from prior verified distillation.",
      audit: {
        noveltyScore,
        transferabilityScore,
        antiTriggerQuality: "adequate",
        verdict: "keep",
        reasoning: "Previously verified pattern.",
      },
    };

    records.push({
      filename,
      patternId,
      title,
      maturityTag,
      citedFiles,
      rawMarkdown,
      verifiedPattern: vp,
    });
  }

  return records;
}

/**
 * Applies incremental update decisions (promote, deprecate, add, unchanged) to
 * an existing skill directory, enforcing grounding and Novelty Gate on new additions.
 */
export async function applyIncrementalDecisions(params: {
  outSkillDir: string;
  report: DistillReport;
  fromSha: string;
  toSha: string;
  analysisRoot: string;
  decisions: IncrementalUpdateOutput;
  judgeModelId: string;
  judgeReasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  budget: BudgetLedger;
  minNovelty: number;
  skipNovelty: boolean;
}): Promise<{
  promoted: number;
  added: number;
  deprecated: number;
  report: DistillReport;
}> {
  const patternsDir = join(params.outSkillDir, "references", "patterns");
  mkdirSync(patternsDir, { recursive: true });

  const existing = loadExistingPatterns(patternsDir);
  const promoMap = new Map(params.decisions.promotions.map((p) => [p.patternId, p]));
  const depMap = new Map(params.decisions.deprecations.map((d) => [d.patternId, d]));

  let promoted = 0;
  let deprecated = 0;
  let added = 0;

  const finalPatterns: Array<{ vp: VerifiedPattern; preservedMarkdown?: string }> = [];
  const replacementCandidates: CandidatePattern[] = [];

  for (const rec of existing) {
    const dep = depMap.get(rec.patternId);
    if (dep) {
      deprecated += 1;
      const oldPath = join(patternsDir, rec.filename);
      if (existsSync(oldPath)) rmSync(oldPath, { force: true });
      if (dep.replacementPattern) {
        replacementCandidates.push(dep.replacementPattern);
      }
      continue;
    }

    const promo = promoMap.get(rec.patternId);
    if (promo) {
      const updatedVp: VerifiedPattern = {
        ...rec.verifiedPattern,
        pattern: {
          ...rec.verifiedPattern.pattern,
          maturityTag: "production_proven",
          citations: promo.updatedCitation
            ? [promo.updatedCitation, ...rec.verifiedPattern.pattern.citations.slice(1)]
            : rec.verifiedPattern.pattern.citations,
        },
      };
      promoted += 1;
      finalPatterns.push({ vp: updatedVp });
      continue;
    }

    // Unchanged: preserve verbatim markdown without rewriting
    finalPatterns.push({ vp: rec.verifiedPattern, preservedMarkdown: rec.rawMarkdown });
  }

  const allNewCandidates = [...params.decisions.additions, ...replacementCandidates];
  if (allNewCandidates.length > 0) {
    const grounded = groundCandidatePatterns(allNewCandidates, params.analysisRoot);
    let verifiedAdditions: VerifiedPattern[] = [];

    if (params.skipNovelty) {
      verifiedAdditions = grounded.groundedPatterns.map((p) => ({
        pattern: p,
        groundingVerified: true,
        blindBaselineSummary: "Skipped via --skip-novelty",
        audit: {
          noveltyScore: 4,
          transferabilityScore: 4,
          antiTriggerQuality: "adequate",
          verdict: "keep",
          reasoning: "Novelty gate bypassed via --skip-novelty.",
        },
      }));
    } else if (grounded.groundedPatterns.length > 0) {
      const novelty = await runNoveltyGate({
        patterns: grounded.groundedPatterns,
        primaryLanguage: params.report.profile.primaryLanguage,
        judgeModelId: params.judgeModelId,
        judgeReasoningEffort: params.judgeReasoningEffort,
        codexPath: params.codexPath,
        budget: params.budget,
        minNovelty: params.minNovelty,
      });
      verifiedAdditions = novelty.kept;
    }

    for (const vp of verifiedAdditions) {
      added += 1;
      finalPatterns.push({ vp });
    }
  }

  // Write updated pattern files (preserving unchanged files verbatim)
  finalPatterns.forEach((item, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const filename = `${num}-${item.vp.pattern.id}.md`;
    const targetPath = join(patternsDir, filename);
    if (item.preservedMarkdown !== undefined) {
      writeFileSync(targetPath, item.preservedMarkdown);
    } else {
      const { markdown } = renderPatternFile(item.vp, params.report.profile.primaryLanguage);
      writeFileSync(targetPath, markdown);
    }
  });

  const updatedProfile: RepoProfile = {
    ...params.report.profile,
    commitSha: params.toSha,
    analyzedAt: new Date().toISOString(),
  };

  const { markdown: skillMd, tokenCount: skillIndexTokens } = renderSkillIndex({
    profile: updatedProfile,
    operatingConstraints: [`Incremental update ${params.fromSha.slice(0, 8)}..${params.toSha.slice(0, 8)}`],
    patterns: finalPatterns.map((f) => f.vp),
    unverified: params.skipNovelty,
    groundingMode: params.report.groundingMode ?? "verified_disk",
  });
  writeFileSync(join(params.outSkillDir, "SKILL.md"), skillMd);

  const historyEntry: UpdateHistoryEntry = {
    fromSha: params.fromSha,
    toSha: params.toSha,
    promoted,
    added,
    deprecated,
    costUsd: Number(params.budget.getTotalCostUsd().toFixed(6)),
    updatedAt: new Date().toISOString(),
  };

  const updatedReport: DistillReport = {
    ...params.report,
    profile: updatedProfile,
    patternsKept: finalPatterns.length,
    costs: [...params.report.costs, ...params.budget.getEntries()],
    totalCostUsd: Number((params.report.totalCostUsd + params.budget.getTotalCostUsd()).toFixed(6)),
    skillIndexTokens,
    updateHistory: [...(params.report.updateHistory ?? []), historyEntry],
  };

  writeFileSync(join(params.outSkillDir, "distill-report.json"), JSON.stringify(updatedReport, null, 2));
  return { promoted, added, deprecated, report: updatedReport };
}

export type IncrementalRunOutcome =
  | { status: "fallback_to_full"; reason: string }
  | { status: "up_to_date"; headSha: string }
  | { status: "docs_only"; fromSha: string; toSha: string; report: DistillReport }
  | { status: "updated"; fromSha: string; toSha: string; promoted: number; added: number; deprecated: number; report: DistillReport };

export async function runIncrementalUpdate(params: {
  repoRoot: string;
  analysisRoot: string;
  outDir: string;
  skillSlug: string;
  headSha: string | null;
  modelId: string;
  judgeModelId: string;
  reasoningEffort?: ReasoningEffort | undefined;
  judgeReasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  budget: BudgetLedger;
  minNovelty: number;
  skipNovelty: boolean;
}): Promise<IncrementalRunOutcome> {
  const outSkillDir = resolve(params.outDir, params.skillSlug);
  const reportPath = join(outSkillDir, "distill-report.json");

  if (!existsSync(reportPath)) {
    return { status: "fallback_to_full", reason: `No existing report at ${reportPath}` };
  }

  const parsed = DistillReportSchema.safeParse(JSON.parse(readFileSync(reportPath, "utf8")));
  if (!parsed.success || !parsed.data.profile.commitSha) {
    return { status: "fallback_to_full", reason: "Existing report missing valid lastCommitSha" };
  }

  const priorReport = parsed.data;
  const fromSha = priorReport.profile.commitSha!;
  const toSha = params.headSha;
  if (!toSha) {
    return { status: "fallback_to_full", reason: "Target repository has no git HEAD commit SHA" };
  }

  if (toSha === fromSha) {
    return { status: "up_to_date", headSha: toSha };
  }

  const delta = computeGitDelta(params.repoRoot, fromSha, toSha);
  if (delta.changedSourceFiles.length === 0) {
    const historyEntry: UpdateHistoryEntry = {
      fromSha,
      toSha,
      promoted: 0,
      added: 0,
      deprecated: 0,
      costUsd: 0,
      updatedAt: new Date().toISOString(),
    };
    const updatedReport: DistillReport = {
      ...priorReport,
      profile: {
        ...priorReport.profile,
        commitSha: toSha,
        analyzedAt: new Date().toISOString(),
      },
      updateHistory: [...(priorReport.updateHistory ?? []), historyEntry],
    };
    writeFileSync(reportPath, JSON.stringify(updatedReport, null, 2));
    return { status: "docs_only", fromSha, toSha, report: updatedReport };
  }

  const existingPatterns = loadExistingPatterns(join(outSkillDir, "references", "patterns"));
  const compactExisting = existingPatterns.map((p) => ({
    patternId: p.patternId,
    title: p.title,
    maturityTag: p.maturityTag,
    citedFiles: p.citedFiles,
  }));

  const template = loadPromptTemplate("incremental-updater.md");
  const prompt = renderTemplate(template, {
    skillSlug: params.skillSlug,
    repoName: priorReport.profile.repoName,
    fromSha: fromSha.slice(0, 8),
    toSha: toSha.slice(0, 8),
    existingPatternsJson: JSON.stringify(compactExisting, null, 2),
    gitLog: delta.gitLog || "(no commit log)",
    boundedDelta: delta.boundedDelta || "(empty diff)",
  });

  const { object: decisions } = await callStructuredLlm({
    stage: "incremental_updater",
    modelId: params.modelId,
    reasoningEffort: params.reasoningEffort,
    codexPath: params.codexPath,
    prompt,
    schema: IncrementalUpdateOutputSchema,
    maxOutputTokens: 6144,
    budget: params.budget,
  });

  const applied = await applyIncrementalDecisions({
    outSkillDir,
    report: priorReport,
    fromSha,
    toSha,
    analysisRoot: params.analysisRoot,
    decisions,
    judgeModelId: params.judgeModelId,
    judgeReasoningEffort: params.judgeReasoningEffort,
    codexPath: params.codexPath,
    budget: params.budget,
    minNovelty: params.minNovelty,
    skipNovelty: params.skipNovelty,
  });

  return {
    status: "updated",
    fromSha,
    toSha,
    ...applied,
  };
}
