import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { countTokens } from "../core/tokens";
import { DistillReportSchema, type DistillReport } from "../schemas/report";

export const SKILL_INDEX_MAX_TOKENS = 1200;
export const PATTERN_FILE_MAX_TOKENS = 900;

export interface PatternVerifyResult {
  file: string;
  tokens: number;
  withinCap: boolean;
  missingCitedPaths: string[];
  traversalPaths: string[];
}

export interface SkillVerifyResult {
  ok: boolean;
  skillDir: string;
  skillIndexExists: boolean;
  skillIndexTokens: number;
  skillIndexWithinCap: boolean;
  reportValid: boolean;
  reportErrors: string[];
  reportSummary?: {
    skillSlug: string;
    groundingMode: string;
    patternsKept: number;
    patternsDropped: number;
    groundingFailures: number;
    totalCostUsd: number;
  };
  patterns: PatternVerifyResult[];
  errors: string[];
}

function extractCitedPaths(markdown: string): string[] {
  const paths = new Set<string>();
  const linkRegex = /`([^`]+?):(\d+)(?:-(\d+))?`/g;
  for (const match of markdown.matchAll(linkRegex)) {
    const filePath = match[1]?.trim();
    if (filePath) paths.add(filePath);
  }
  return Array.from(paths);
}

/** Deterministically verifies a compiled skill directory against token caps, report schema, and optional disk citations. */
export function verifySkillDirectory(skillDir: string, repoPath?: string): SkillVerifyResult {
  const absDir = resolve(skillDir);
  const errors: string[] = [];
  const reportErrors: string[] = [];

  const skillMdPath = join(absDir, "SKILL.md");
  const skillIndexExists = existsSync(skillMdPath);
  let skillIndexTokens = 0;
  let skillIndexWithinCap = false;

  if (!skillIndexExists) {
    errors.push(`Missing SKILL.md in ${absDir}`);
  } else {
    skillIndexTokens = countTokens(readFileSync(skillMdPath, "utf8"));
    skillIndexWithinCap = skillIndexTokens <= SKILL_INDEX_MAX_TOKENS;
    if (!skillIndexWithinCap) {
      errors.push(`SKILL.md exceeds ${SKILL_INDEX_MAX_TOKENS} token cap (${skillIndexTokens} tokens)`);
    }
  }

  let reportValid = false;
  let parsedReport: DistillReport | undefined;
  const reportPath = join(absDir, "distill-report.json");
  if (!existsSync(reportPath)) {
    reportErrors.push("Missing distill-report.json");
  } else {
    try {
      const raw: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
      const parsed = DistillReportSchema.safeParse(raw);
      if (parsed.success) {
        reportValid = true;
        parsedReport = parsed.data;
      } else {
        for (const issue of parsed.error.issues) {
          reportErrors.push(`${issue.path.join(".")}: ${issue.message}`);
        }
      }
    } catch (err) {
      reportErrors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (!reportValid) {
    errors.push(...reportErrors.map((e) => `distill-report.json: ${e}`));
  }

  const patternsDir = join(absDir, "references", "patterns");
  const patterns: PatternVerifyResult[] = [];
  const resolvedRepo = repoPath ? resolve(repoPath) : undefined;
  const normalizedRepo = resolvedRepo
    ? (resolvedRepo.endsWith(sep) ? resolvedRepo : `${resolvedRepo}${sep}`)
    : undefined;

  if (existsSync(patternsDir)) {
    const entries = readdirSync(patternsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    for (const entry of entries) {
      const fullPath = join(patternsDir, entry);
      const content = readFileSync(fullPath, "utf8");
      const tokens = countTokens(content);
      const withinCap = tokens <= PATTERN_FILE_MAX_TOKENS;
      if (!withinCap) {
        errors.push(`references/patterns/${entry} exceeds ${PATTERN_FILE_MAX_TOKENS} token cap (${tokens} tokens)`);
      }

      const missingCitedPaths: string[] = [];
      const traversalPaths: string[] = [];
      if (resolvedRepo && normalizedRepo) {
        for (const cited of extractCitedPaths(content)) {
          const target = resolve(resolvedRepo, cited);
          if (target !== resolvedRepo && !target.startsWith(normalizedRepo)) {
            traversalPaths.push(cited);
            errors.push(`Path traversal in ${entry}: ${cited}`);
          } else if (!existsSync(target)) {
            missingCitedPaths.push(cited);
            errors.push(`Missing cited file in ${entry}: ${cited}`);
          }
        }
      }

      patterns.push({
        file: entry,
        tokens,
        withinCap,
        missingCitedPaths,
        traversalPaths,
      });
    }
  }

  return {
    ok: errors.length === 0,
    skillDir: absDir,
    skillIndexExists,
    skillIndexTokens,
    skillIndexWithinCap,
    reportValid,
    reportErrors,
    ...(parsedReport
      ? {
          reportSummary: {
            skillSlug: parsedReport.profile.skillSlug,
            groundingMode: parsedReport.groundingMode ?? "verified_disk",
            patternsKept: parsedReport.patternsKept,
            patternsDropped: parsedReport.patternsDropped.length,
            groundingFailures: parsedReport.groundingFailures,
            totalCostUsd: parsedReport.totalCostUsd,
          },
        }
      : {}),
    patterns,
    errors,
  };
}
