import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { BudgetLedger } from "../../core/budget";
import type { ReasoningEffort } from "../../core/config";
import { callStructuredLlm } from "../../core/llm";
import { loadPromptTemplate, renderTemplate } from "../../core/prompts";
import { countTokens } from "../../core/tokens";
import {
  LoadedSkillPatternSchema,
  MergeSynthesisOutputSchema,
  type LoadedCitation,
  type LoadedSkill,
  type LoadedSkillPattern,
  type MergedPatternPlan,
  type MergeSynthesisOutput,
  type SnippetRef,
} from "../../schemas/merge";
import { DistillReportSchema, type DistillReport, type DroppedPatternLog } from "../../schemas/report";
import { PatternCategorySchema, MaturityTagSchema } from "../../schemas/pattern";

const SKILL_INDEX_HARD_CAP = 1200;
const PATTERN_HARD_CAP = 900;

export class MergeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeInputError";
  }
}

function isSkillDir(dir: string): boolean {
  return (
    existsSync(join(dir, "distill-report.json")) &&
    existsSync(join(dir, "references", "patterns"))
  );
}

/**
 * Discovers >= 2 valid distilled skill directories from either explicit paths
 * or a single parent directory containing multiple distilled skill subdirectories.
 */
export function discoverSkillDirs(inputs: string[]): string[] {
  const discovered: string[] = [];
  const seen = new Set<string>();

  for (const raw of inputs) {
    const abs = resolve(raw);
    if (!existsSync(abs)) {
      throw new MergeInputError(`Skill directory does not exist: ${raw}`);
    }

    if (isSkillDir(abs)) {
      if (!seen.has(abs)) {
        seen.add(abs);
        discovered.push(abs);
      }
      continue;
    }

    // Check if it is a parent directory containing multiple distilled skills
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    let foundChild = false;
    for (const entry of entries) {
      const child = join(abs, entry.name);
      if (isSkillDir(child)) {
        foundChild = true;
        if (!seen.has(child)) {
          seen.add(child);
          discovered.push(child);
        }
      }
    }

    if (!foundChild) {
      throw new MergeInputError(
        `Directory "${raw}" is neither a distilled skill (missing distill-report.json + references/patterns/) nor a parent containing distilled skills.`,
      );
    }
  }

  if (discovered.length < 2) {
    throw new MergeInputError(
      `At least 2 valid distilled skill directories are required for merge (found ${discovered.length}).`,
    );
  }

  return discovered;
}

function extractSection(md: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=^## |\\Z)`, "m");
  const match = md.match(re);
  return match?.[1]?.trim() ?? "";
}

function extractBullets(sectionText: string): string[] {
  return sectionText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[*|-]\s+/.test(l))
    .map((l) => l.replace(/^[*|-]\s+/, "").trim())
    .filter(Boolean);
}

function extractTransferableRulesFromSkillMd(skillDir: string): Map<string, string> {
  const rules = new Map<string, string>();
  const skillMdPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) return rules;
  const raw = readFileSync(skillMdPath, "utf8");
  const ruleRe = /^-\s+\*\*(.+?)\*\*:\s+(.+)$/gm;
  for (const m of raw.matchAll(ruleRe)) {
    if (m[1] && m[2]) {
      rules.set(m[1].trim(), m[2].trim());
    }
  }
  return rules;
}

/** Parses a references/patterns/*.md file and enforces required provenance fields. */
export function parsePatternMarkdown(
  md: string,
  report: DistillReport,
  filename: string,
  rulesByTitle?: Map<string, string>,
): LoadedSkillPattern {
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim();
  if (!title) {
    throw new MergeInputError(`Pattern file "${filename}" is missing a top-level # Title.`);
  }

  const categoryRaw = md.match(/^-\s+\*\*Category\*\*:\s+`([^`]+)`/m)?.[1];
  const maturityRaw = md.match(/^-\s+\*\*Maturity\*\*:\s+`([^`]+)`/m)?.[1];
  const evidenceRaw = md.match(/^-\s+\*\*Evidence\*\*:\s+`([^`]+)`/m)?.[1];
  const auditMatch = md.match(/^-\s+\*\*Novelty Audit\*\*:\s+`(\d+)\/5`\s+\(Transferability:\s+`(\d+)\/5`\)/m);

  const category = PatternCategorySchema.parse(categoryRaw ?? "architecture");
  const maturityTag = MaturityTagSchema.parse(maturityRaw ?? "production_proven");
  const evidenceStatus = evidenceRaw === "inferred_from_code" ? "inferred_from_code" : "seen_explicit";
  const noveltyScore = auditMatch?.[1] ? Number(auditMatch[1]) : 4;
  const transferabilityScore = auditMatch?.[2] ? Number(auditMatch[2]) : 4;

  const problemStatement = extractSection(md, "Problem");
  const naiveApproach = extractSection(md, "Default Approach (And Why It Breaks)");
  const repoApproach = extractSection(md, "Repository Pattern");
  const evidenceSection = extractSection(md, "Verified Source Evidence");
  const tradeOffs = extractBullets(extractSection(md, "Trade-Offs"));
  const whenToApply = extractBullets(extractSection(md, "When to Apply"));
  const antiTriggers = extractBullets(extractSection(md, "Anti-Triggers (Do NOT Apply When)"));

  const citations: LoadedCitation[] = [];
  const citationRe =
    /\*\*`([^`]+)`\s+\(Lines\s+(\d+)[–-](\d+)\)\*\*(?:\s+·\s+Commit\s+`([^`]+)`)?[^\n]*\n```([^\n]*)\n([\s\S]*?)\n```/g;

  for (const m of evidenceSection.matchAll(citationRe)) {
    const filePath = m[1]?.trim() ?? "";
    const startLine = Number(m[2]);
    const endLine = Number(m[3]);
    const commitSha = m[4]?.trim() || report.profile.commitSha || undefined;
    const fenceLang = m[5]?.trim() || "text";
    const verbatimSnippet = m[6] ?? "";

    if (!filePath || !Number.isFinite(startLine) || !Number.isFinite(endLine) || !verbatimSnippet) {
      continue;
    }

    citations.push({
      filePath,
      startLine,
      endLine,
      ...(commitSha ? { commitSha } : {}),
      verbatimSnippet,
      fenceLang,
    });
  }

  const sourceCommitSha = report.profile.commitSha ?? citations[0]?.commitSha ?? "";
  if (!report.profile.source || !sourceCommitSha || citations.length === 0) {
    throw new MergeInputError(
      `Pattern "${filename}" in skill "${report.profile.skillSlug}" lacks required provenance (source, commitSha, filePath, startLine, endLine).`,
    );
  }

  const patternId = basename(filename, ".md").replace(/^\d+-/, "");
  const transferableRule =
    rulesByTitle?.get(title) ??
    (repoApproach.split(/(?<=[.!?])\s+/)[0] || title);

  return LoadedSkillPatternSchema.parse({
    sourceSkillId: report.profile.skillSlug,
    sourceRepoName: report.profile.repoName,
    sourceUrl: report.profile.source,
    sourceCommitSha,
    patternId,
    title,
    category,
    maturityTag,
    evidenceStatus,
    noveltyScore,
    transferabilityScore,
    problemStatement: problemStatement || title,
    naiveApproach: naiveApproach || "Standard ad-hoc implementation.",
    repoApproach: repoApproach || title,
    transferableRule,
    tradeOffs: tradeOffs.length > 0 ? tradeOffs : ["Requires careful adherence to invariants."],
    whenToApply: whenToApply.length > 0 ? whenToApply : ["When implementing similar subsystems."],
    antiTriggers: antiTriggers.length > 0 ? antiTriggers : ["Simple one-off scripts."],
    citations,
  });
}

/** Loads and validates >= 2 distilled skills from disk. */
export function loadDistilledSkills(inputs: string[]): LoadedSkill[] {
  const skillDirs = discoverSkillDirs(inputs);
  const loaded: LoadedSkill[] = [];

  for (const dir of skillDirs) {
    const reportRaw = readFileSync(join(dir, "distill-report.json"), "utf8");
    const reportParsed = DistillReportSchema.safeParse(JSON.parse(reportRaw));
    if (!reportParsed.success) {
      throw new MergeInputError(
        `Invalid distill-report.json in "${dir}": ${reportParsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    const report = reportParsed.data;
    if (!report.profile.source) {
      throw new MergeInputError(`Skill "${dir}" is missing profile.source in distill-report.json.`);
    }

    const rulesByTitle = extractTransferableRulesFromSkillMd(dir);
    const patternsDir = join(dir, "references", "patterns");
    const patternFiles = readdirSync(patternsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    if (patternFiles.length === 0) {
      throw new MergeInputError(`Skill "${dir}" has no pattern files in references/patterns/.`);
    }

    const patterns = patternFiles.map((f) =>
      parsePatternMarkdown(readFileSync(join(patternsDir, f), "utf8"), report, f, rulesByTitle),
    );

    loaded.push({ skillDir: dir, report, patterns });
  }

  return loaded;
}

export interface ResolvedMergedCitation {
  repoName: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  fenceLang: string;
  verbatimSnippet: string;
}

export interface CompiledMergedPattern {
  filename: string;
  plan: MergedPatternPlan;
  citations: ResolvedMergedCitation[];
  conflictBranches: Array<{
    sourceRepo: string;
    whenThisWins: string;
    approach: string;
    citation: ResolvedMergedCitation;
  }>;
  markdown: string;
  tokenCount: number;
}

function resolveSnippetRef(
  ref: SnippetRef,
  patternIndex: Map<string, LoadedSkillPattern>,
): ResolvedMergedCitation | null {
  const srcPattern = patternIndex.get(`${ref.sourceSkillId}::${ref.patternId}`);
  if (!srcPattern) return null;
  const cit = srcPattern.citations[ref.citationIndex] ?? srcPattern.citations[0];
  if (!cit) return null;
  return {
    repoName: srcPattern.sourceRepoName,
    commitSha: (cit.commitSha ?? srcPattern.sourceCommitSha).slice(0, 8),
    filePath: cit.filePath,
    startLine: cit.startLine,
    endLine: cit.endLine,
    fenceLang: cit.fenceLang,
    verbatimSnippet: cit.verbatimSnippet,
  };
}

function formatMergedPatternMarkdown(
  plan: MergedPatternPlan,
  citations: ResolvedMergedCitation[],
  conflictBranches: CompiledMergedPattern["conflictBranches"],
  snippetMaxLines?: number,
): string {
  const lines: string[] = [
    `# ${plan.title}`,
    "",
    `- **Category**: \`${plan.category}\``,
    `- **Maturity**: \`${plan.maturityTag}\``,
    `- **Consensus**: \`${plan.consensusCount} repo(s)\``,
    `- **Novelty Audit**: \`${plan.noveltyScore}/5\` (Transferability: \`${plan.transferabilityScore}/5\`)`,
    "",
    "## Problem",
    plan.problemStatement,
    "",
    "## Default Approach (And Why It Breaks)",
    plan.naiveApproach,
    "",
    "## Canonical Pattern",
    plan.repoApproach,
    "",
  ];

  if (conflictBranches.length > 0) {
    lines.push("## Conflicting Approaches (Conditional Decision Branches)", "");
    for (const branch of conflictBranches) {
      lines.push(
        `### When \`${branch.sourceRepo}\` Wins: ${branch.whenThisWins}`,
        branch.approach,
        "",
      );
    }
  }

  lines.push("## Verified Multi-Repo Source Evidence");
  const allCitations = [
    ...citations,
    ...conflictBranches.map((b) => b.citation),
  ];
  const seenCit = new Set<string>();

  for (const c of allCitations) {
    const key = `${c.repoName}@${c.commitSha}:${c.filePath}:${c.startLine}-${c.endLine}`;
    if (seenCit.has(key)) continue;
    seenCit.add(key);

    let snippet = c.verbatimSnippet;
    let endLine = c.endLine;
    let condensedNote = "";

    if (snippetMaxLines !== undefined) {
      const sLines = snippet.split("\n");
      if (sLines.length > snippetMaxLines) {
        snippet = `${sLines.slice(0, snippetMaxLines).join("\n")}\n// ... [condensed for token budget]`;
        endLine = Math.min(c.endLine, c.startLine + snippetMaxLines - 1);
        condensedNote = " *(excerpt condensed)*";
      }
    }

    lines.push(
      `**\`${c.repoName}@${c.commitSha}:${c.filePath}\` (Lines ${c.startLine}–${endLine})**${condensedNote}`,
      `\`\`\`${c.fenceLang}`,
      snippet,
      "```",
      "",
    );
  }

  lines.push("## Trade-Offs", "");
  for (const t of plan.tradeOffs) lines.push(`* ${t}`);

  lines.push("", "## When to Apply", "");
  for (const w of plan.whenToApply) lines.push(`* ${w}`);

  lines.push("", "## Anti-Triggers (Do NOT Apply When)", "");
  for (const a of plan.antiTriggers) lines.push(`* ${a}`);

  return `${lines.join("\n")}\n`;
}

function renderMergedPatternWithCap(
  plan: MergedPatternPlan,
  citations: ResolvedMergedCitation[],
  conflictBranches: CompiledMergedPattern["conflictBranches"],
): { markdown: string; tokenCount: number } {
  let markdown = formatMergedPatternMarkdown(plan, citations, conflictBranches);
  let tokens = countTokens(markdown);
  if (tokens <= PATTERN_HARD_CAP) {
    return { markdown, tokenCount: tokens };
  }

  for (const maxLines of [20, 12, 6, 3]) {
    markdown = formatMergedPatternMarkdown(plan, citations, conflictBranches, maxLines);
    tokens = countTokens(markdown);
    if (tokens <= PATTERN_HARD_CAP) {
      return { markdown, tokenCount: tokens };
    }
  }

  return { markdown, tokenCount: tokens };
}

function limitWords(text: string, maxWords: number): string {
  const words = text.replace(/\|/g, "/").replace(/\s+/g, " ").trim().split(" ");
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function buildMergedSkillMd(params: {
  outputSlug: string;
  loadedSkills: LoadedSkill[];
  operatingConstraints: string[];
  patterns: CompiledMergedPattern[];
  maxCellWords?: number;
  includeQuickRules: boolean;
  quickRulesLimit?: number;
}): string {
  const { outputSlug, loadedSkills, operatingConstraints, patterns, maxCellWords, includeQuickRules, quickRulesLimit } =
    params;

  const sourceList = loadedSkills
    .map((s) => `${s.report.profile.repoName}@${(s.report.profile.commitSha ?? "unknown").slice(0, 8)}`)
    .join(", ");
  const topCategories = Array.from(new Set(patterns.map((p) => p.plan.category))).slice(0, 3).join(", ");

  const lines: string[] = [
    "---",
    `name: ${outputSlug}`,
    `description: Unified cross-repo engineering playbook synthesized from ${loadedSkills.length} repositories (${topCategories || "systems"}).`,
    "---",
    "",
    `# ${outputSlug} — Cross-Repo Engineering Playbook`,
    "",
    `- **Synthesized From (${loadedSkills.length} repos)**: ${sourceList}`,
    `- **Operating Context**: ${operatingConstraints.join("; ")}`,
    "",
    "## Pattern Decision Table (Grouped by Category)",
  ];

  // Group patterns by category cleanly
  const byCategory = new Map<string, CompiledMergedPattern[]>();
  for (const p of patterns) {
    const list = byCategory.get(p.plan.category) ?? [];
    list.push(p);
    byCategory.set(p.plan.category, list);
  }

  for (const [category, group] of byCategory.entries()) {
    lines.push("", `### \`${category}\``, "");
    lines.push("| Pattern | Load When (Trigger) | Skip When (Anti-Trigger) | Reference |");
    lines.push("| :--- | :--- | :--- | :--- |");
    for (const p of group) {
      const trigger = maxCellWords
        ? limitWords(p.plan.whenToApply[0] ?? "", maxCellWords)
        : (p.plan.whenToApply[0] ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
      const anti = maxCellWords
        ? limitWords(p.plan.antiTriggers[0] ?? "", maxCellWords)
        : (p.plan.antiTriggers[0] ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
      lines.push(
        `| ${p.plan.title} | ${trigger} | ${anti} | [\`${p.filename}\`](references/patterns/${p.filename}) |`,
      );
    }
  }

  if (includeQuickRules) {
    const ruleSlice = quickRulesLimit !== undefined ? patterns.slice(0, quickRulesLimit) : patterns;
    if (ruleSlice.length > 0) {
      lines.push("", "## Quick Transferable Rules");
      for (const p of ruleSlice) {
        lines.push(`- **${p.plan.title}**: ${p.plan.transferableRule}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Deterministically compiles the unified playbook from LLM synthesis output,
 * re-attaching verbatim disk-verified snippets, enforcing --max-patterns,
 * and enforcing SKILL.md <= 1,200 tokens and pattern files <= 900 tokens.
 */
export function compileMergedPlaybook(params: {
  loadedSkills: LoadedSkill[];
  synthesis: MergeSynthesisOutput;
  outputSlug: string;
  maxPatterns: number;
}): {
  compiledPatterns: CompiledMergedPattern[];
  droppedPatterns: DroppedPatternLog[];
  skillMd: string;
  skillIndexTokens: number;
} {
  const effectiveMax = Math.min(Math.max(1, params.maxPatterns), 15);
  const patternIndex = new Map<string, LoadedSkillPattern>();
  for (const skill of params.loadedSkills) {
    for (const p of skill.patterns) {
      patternIndex.set(`${p.sourceSkillId}::${p.patternId}`, p);
    }
  }

  const ranked = [...params.synthesis.mergedPatterns].sort(
    (a, b) =>
      b.noveltyScore - a.noveltyScore ||
      b.transferabilityScore - a.transferabilityScore ||
      b.consensusCount - a.consensusCount,
  );

  const keptPlans = ranked.slice(0, effectiveMax);
  const overflowPlans = ranked.slice(effectiveMax);

  const droppedPatterns: DroppedPatternLog[] = [
    ...(params.synthesis.droppedPatterns ?? []).map((d) => ({
      patternId: `${d.sourceSkillId}:${d.patternId}`,
      title: d.title,
      stage: "merge_overflow" as const,
      reason: d.reason,
    })),
    ...overflowPlans.map((p) => ({
      patternId: p.id,
      title: p.title,
      stage: "merge_overflow" as const,
      reason: `Exceeded --max-patterns (${effectiveMax}) cap.`,
      noveltyScore: p.noveltyScore,
    })),
  ];

  const compiledPatterns: CompiledMergedPattern[] = [];
  for (const plan of keptPlans) {
    const citations: ResolvedMergedCitation[] = [];
    for (const ref of plan.snippetRefs) {
      const resolved = resolveSnippetRef(ref, patternIndex);
      if (resolved) citations.push(resolved);
    }
    if (citations.length === 0) {
      droppedPatterns.push({
        patternId: plan.id,
        title: plan.title,
        stage: "merge_overflow",
        reason: "No valid disk-grounded snippetRefs resolved.",
        noveltyScore: plan.noveltyScore,
      });
      continue;
    }

    const conflictBranches: CompiledMergedPattern["conflictBranches"] = [];
    for (const b of plan.conflictBranches ?? []) {
      const resolved = resolveSnippetRef(b.snippetRef, patternIndex);
      if (resolved) {
        conflictBranches.push({
          sourceRepo: b.sourceRepo,
          whenThisWins: b.whenThisWins,
          approach: b.approach,
          citation: resolved,
        });
      }
    }

    const num = String(compiledPatterns.length + 1).padStart(2, "0");
    const filename = `${num}-${plan.id}.md`;
    const { markdown, tokenCount } = renderMergedPatternWithCap(plan, citations, conflictBranches);
    compiledPatterns.push({
      filename,
      plan,
      citations,
      conflictBranches,
      markdown,
      tokenCount,
    });
  }

  let skillMd = buildMergedSkillMd({
    outputSlug: params.outputSlug,
    loadedSkills: params.loadedSkills,
    operatingConstraints: params.synthesis.operatingConstraints,
    patterns: compiledPatterns,
    includeQuickRules: true,
  });

  if (countTokens(skillMd) > SKILL_INDEX_HARD_CAP) {
    skillMd = buildMergedSkillMd({
      outputSlug: params.outputSlug,
      loadedSkills: params.loadedSkills,
      operatingConstraints: params.synthesis.operatingConstraints,
      patterns: compiledPatterns,
      maxCellWords: 16,
      includeQuickRules: true,
    });
  }

  if (countTokens(skillMd) > SKILL_INDEX_HARD_CAP) {
    for (let limit = compiledPatterns.length - 1; limit >= 0; limit--) {
      skillMd = buildMergedSkillMd({
        outputSlug: params.outputSlug,
        loadedSkills: params.loadedSkills,
        operatingConstraints: params.synthesis.operatingConstraints,
        patterns: compiledPatterns,
        maxCellWords: 14,
        includeQuickRules: limit > 0,
        quickRulesLimit: limit,
      });
      if (countTokens(skillMd) <= SKILL_INDEX_HARD_CAP) break;
    }
  }

  if (countTokens(skillMd) > SKILL_INDEX_HARD_CAP) {
    for (const words of [10, 6]) {
      skillMd = buildMergedSkillMd({
        outputSlug: params.outputSlug,
        loadedSkills: params.loadedSkills,
        operatingConstraints: params.synthesis.operatingConstraints,
        patterns: compiledPatterns,
        maxCellWords: words,
        includeQuickRules: false,
      });
      if (countTokens(skillMd) <= SKILL_INDEX_HARD_CAP) break;
    }
  }

  return {
    compiledPatterns,
    droppedPatterns,
    skillMd,
    skillIndexTokens: countTokens(skillMd),
  };
}

export async function mergeSkills(params: {
  skillDirs: string[];
  outputSlug: string;
  maxPatterns: number;
  modelId: string;
  reasoningEffort?: ReasoningEffort | undefined;
  codexPath?: string | undefined;
  budget: BudgetLedger;
}) {
  const loadedSkills = loadDistilledSkills(params.skillDirs);
  const compactSkills = loadedSkills.map((s) => ({
    skillId: s.report.profile.skillSlug,
    repoName: s.report.profile.repoName,
    source: s.report.profile.source,
    commitSha: s.report.profile.commitSha,
    patterns: s.patterns.map((p) => ({
      patternId: p.patternId,
      title: p.title,
      category: p.category,
      maturityTag: p.maturityTag,
      noveltyScore: p.noveltyScore,
      transferabilityScore: p.transferabilityScore,
      problemStatement: p.problemStatement,
      naiveApproach: p.naiveApproach,
      repoApproach: p.repoApproach,
      transferableRule: p.transferableRule,
      tradeOffs: p.tradeOffs,
      whenToApply: p.whenToApply,
      antiTriggers: p.antiTriggers,
      citations: p.citations.map((c, idx) => ({
        citationIndex: idx,
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
      })),
    })),
  }));

  const template = loadPromptTemplate("merge-synthesizer.md");
  const prompt = renderTemplate(template, {
    outputSlug: params.outputSlug,
    maxPatterns: String(Math.min(params.maxPatterns, 15)),
    skillsJson: JSON.stringify(compactSkills, null, 2),
  });

  const { object: synthesis } = await callStructuredLlm({
    stage: "merge_synthesizer",
    modelId: params.modelId,
    reasoningEffort: params.reasoningEffort,
    codexPath: params.codexPath,
    prompt,
    schema: MergeSynthesisOutputSchema,
    maxOutputTokens: 8192,
    budget: params.budget,
  });

  const compiled = compileMergedPlaybook({
    loadedSkills,
    synthesis,
    outputSlug: params.outputSlug,
    maxPatterns: params.maxPatterns,
  });

  return { loadedSkills, ...compiled };
}
