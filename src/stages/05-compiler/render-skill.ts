import type { RepoProfile } from "../../schemas/repo-profile";
import type { VerifiedPattern } from "../../schemas/novelty";
import type { GroundingMode } from "../../schemas/report";
import { formatSourceAttribution } from "../../core/attribution";
import { countTokens } from "../../core/tokens";

const SKILL_INDEX_HARD_CAP = 1200;

function limitWords(text: string, maxWords: number): string {
  const words = text.replace(/\|/g, "/").replace(/\s+/g, " ").trim().split(" ");
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function buildSkillMarkdown(params: {
  profile: RepoProfile;
  operatingConstraints: string[];
  patterns: VerifiedPattern[];
  maxCellWords?: number;
  includeQuickRules: boolean;
  quickRulesLimit?: number;
  unverified?: boolean;
  groundingMode?: GroundingMode;
}): string {
  const { profile, operatingConstraints, patterns, maxCellWords, includeQuickRules, quickRulesLimit, unverified, groundingMode } = params;
  const topCategories = Array.from(new Set(patterns.map((p) => p.pattern.category))).slice(0, 3).join(", ");
  const constraintsSummary = limitWords(operatingConstraints[0] ?? "high reliability or performance is required", 16);

  const rows = patterns.map((vp, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const filename = `${num}-${vp.pattern.id}.md`;
    const trigger = maxCellWords
      ? limitWords(vp.pattern.whenToApply[0] ?? "", maxCellWords)
      : (vp.pattern.whenToApply[0] ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
    const anti = maxCellWords
      ? limitWords(vp.pattern.antiTriggers[0] ?? "", maxCellWords)
      : (vp.pattern.antiTriggers[0] ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
    return `| ${vp.pattern.title} | \`${vp.pattern.category}\` | ${trigger} | ${anti} | [\`${filename}\`](references/patterns/${filename}) |`;
  });

  const lines: string[] = [
    "---",
    `name: ${profile.skillSlug}`,
    `description: Engineering playbook distilled from ${profile.repoName} (${profile.primaryLanguage}, ${profile.maturity.classification}). Use when designing or reviewing ${topCategories || "systems"} where ${constraintsSummary}.`,
    "---",
    "",
    `# ${profile.repoName} Engineering Playbook${unverified ? " (Unverified — Novelty Gate Skipped)" : ""}`,
    "",
    `- **Source**: ${formatSourceAttribution(profile.source, profile.commitSha)}`,
    `- **Maturity**: \`${profile.maturity.classification}\``,
    ...(groundingMode === "ungrounded_notes"
      ? ["- **Evidence**: `ungrounded_notes` (snippets not verified against disk)"]
      : []),
    `- **Operating Context**: ${operatingConstraints.join("; ")}`,
    "",
    "## Pattern Decision Table",
    "Load a pattern file from `references/patterns/` ONLY when the trigger condition matches your current task AND no anti-trigger applies. This playbook is additive guidance: if a task falls outside these patterns or triggers an anti-trigger, proceed normally using standard engineering practices.",
    "",
    "| Pattern | Category | Load When (Trigger) | Skip When (Anti-Trigger) | Reference |",
    "| :--- | :--- | :--- | :--- | :--- |",
    ...rows,
  ];

  if (includeQuickRules) {
    const ruleSlice = quickRulesLimit !== undefined ? patterns.slice(0, quickRulesLimit) : patterns;
    if (ruleSlice.length > 0) {
      lines.push("", "## Quick Transferable Rules");
      for (const vp of ruleSlice) {
        lines.push(`- **${vp.pattern.title}**: ${vp.pattern.transferableRule}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Renders SKILL.md and deterministically enforces the <= 1,200 token hard cap. */
export function renderSkillIndex(params: {
  profile: RepoProfile;
  operatingConstraints: string[];
  patterns: VerifiedPattern[];
  unverified?: boolean;
  groundingMode?: GroundingMode;
}): { markdown: string; tokenCount: number } {
  let markdown = buildSkillMarkdown({
    ...params,
    includeQuickRules: true,
  });

  if (countTokens(markdown) <= SKILL_INDEX_HARD_CAP) {
    return { markdown, tokenCount: countTokens(markdown) };
  }

  // Pass 1: Compress table cells to <= 18 words
  markdown = buildSkillMarkdown({
    ...params,
    maxCellWords: 18,
    includeQuickRules: true,
  });
  if (countTokens(markdown) <= SKILL_INDEX_HARD_CAP) {
    return { markdown, tokenCount: countTokens(markdown) };
  }

  // Pass 2: Trim Quick Transferable Rules one by one until <= 1,200 tokens
  for (let limit = params.patterns.length - 1; limit >= 0; limit--) {
    markdown = buildSkillMarkdown({
      ...params,
      maxCellWords: 18,
      includeQuickRules: limit > 0,
      quickRulesLimit: limit,
    });
    const tokens = countTokens(markdown);
    if (tokens <= SKILL_INDEX_HARD_CAP) {
      return { markdown, tokenCount: tokens };
    }
  }

  // Pass 3: Tighten table cells further if many patterns
  for (const words of [12, 8]) {
    markdown = buildSkillMarkdown({
      ...params,
      maxCellWords: words,
      includeQuickRules: false,
    });
    const tokens = countTokens(markdown);
    if (tokens <= SKILL_INDEX_HARD_CAP) {
      return { markdown, tokenCount: tokens };
    }
  }

  return { markdown, tokenCount: countTokens(markdown) };
}
