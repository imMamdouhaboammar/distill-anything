import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger } from "../../core/budget";
import { ingestRepository } from "../01-ingest";
import { buildSignalBundle } from "../02-signals/bundler";
import type { SignalBundle } from "../../schemas/signal-bundle";
import {
  GitHubRepoSummarySchema,
  type GitHubRepoSummary,
  type OrgScanRepoResult,
  type OrgScanReport,
} from "../../schemas/org-scan";

export interface OrgScanOptions {
  org: string;
  limit: number;
  lang?: string | undefined;
  minStars: number;
  maxSizeMb?: number | undefined;
  includeForks: boolean;
  includeArchived: boolean;
  concurrency: number;
  cloneTimeoutMs?: number;
  onWarn?: (msg: string) => void;
  onInfo?: (msg: string) => void;
}

const DEFAULT_CLONE_TIMEOUT_MS = 45_000;

/** Resolves a GitHub token from GITHUB_TOKEN, GH_TOKEN, or `gh auth token`. */
export function resolveGitHubToken(): string | null {
  const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const gh = Bun.spawnSync(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (gh.exitCode === 0) {
      const token = new TextDecoder().decode(gh.stdout).trim();
      if (token) return token;
    }
  } catch {
    // gh CLI not installed or unavailable
  }
  return null;
}

/** Filters GitHub org repositories before any cloning occurs. */
export function filterOrgRepos(
  repos: GitHubRepoSummary[],
  filters: {
    limit: number;
    lang?: string | undefined;
    minStars: number;
    maxSizeMb?: number | undefined;
    includeForks: boolean;
    includeArchived: boolean;
  },
): GitHubRepoSummary[] {
  const normalizedLang = filters.lang?.trim().toLowerCase();
  const maxSizeKb = filters.maxSizeMb !== undefined ? filters.maxSizeMb * 1024 : Infinity;
  const matchesLang = (repoLang: string | null): boolean => {
    if (!normalizedLang) return true;
    if (!repoLang) return false;
    const rl = repoLang.toLowerCase();
    if (rl === normalizedLang) return true;
    if (normalizedLang === "cpp" && rl === "c++") return true;
    if (normalizedLang === "c++" && rl === "cpp") return true;
    return false;
  };

  return repos
    .filter((r) => (filters.includeForks || !r.fork) && (filters.includeArchived || !r.archived))
    .filter((r) => r.stargazers_count >= filters.minStars)
    .filter((r) => matchesLang(r.language))
    .filter((r) => (r.size ?? 0) <= maxSizeKb)
    .slice(0, filters.limit);
}

/** Builds git clone arguments enforcing shallow, single-branch, tagless single-packfile clones. */
export function buildCloneArgs(cloneUrl: string, destDir: string): string[] {
  return ["clone", "--depth", "25", "--no-tags", "--single-branch", cloneUrl, destDir];
}

/** Builds git clone environment enforcing GIT_LFS_SKIP_SMUDGE=1. */
export function buildCloneEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Computes a deterministic, size-normalized signal density score from Stages 1 & 2.
 * Rewards high Bucket A craftDensity/scores, fanIn concentration, maturity, and
 * high-signal commits while normalizing against massive boilerplate monorepos.
 */
export function computeSignalDensityScore(bundle: SignalBundle): number {
  const coreFiles = bundle.files.filter((f) => f.bucket === "core_architecture");
  if (coreFiles.length === 0) return 0;

  const topFive = coreFiles.slice(0, 5);
  const topScoreMax = topFive[0]?.score ?? 0;
  const topScoreAvg = topFive.reduce((sum, f) => sum + f.score, 0) / topFive.length;
  const avgFanIn = coreFiles.reduce((sum, f) => sum + f.fanIn, 0) / coreFiles.length;

  const { maturity, totalFilesScanned } = bundle.profile;
  const maturityBonus =
    (maturity.hasCiWorkflows ? 1.5 : 0) +
    (maturity.hasBenchmarks ? 2.0 : 0) +
    (maturity.hasStrictTyping ? 1.5 : 0) +
    Math.min(maturity.testToSourceRatio, 1.0) * 2.0;

  const commitBonus = Math.min(bundle.commits.length, 15) * 0.4;
  const sizePenalty = totalFilesScanned > 200 ? Math.log10(totalFilesScanned / 200) * 2.5 : 0;

  const raw =
    topScoreMax * 0.45 +
    topScoreAvg * 0.55 +
    Math.log(1 + avgFanIn) * 2.0 +
    maturityBonus +
    commitBonus -
    sizePenalty;

  return Number(Math.max(0, raw).toFixed(2));
}

async function fetchOrgRepos(
  org: string,
  options: OrgScanOptions,
  token: string | null,
): Promise<{
  candidates: GitHubRepoSummary[];
  skippedOversizedRepos: Array<{ name: string; fullName: string; sizeMb: number }>;
}> {
  const collected: GitHubRepoSummary[] = [];
  const maxPages = 5;
  const maxSizeMb = options.maxSizeMb ?? 150;

  for (let page = 1; page <= maxPages; page++) {
    const url =
      `https://api.github.com/orgs/${encodeURIComponent(org)}/repos` +
      `?sort=pushed&direction=desc&per_page=100&page=${page}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "distill-anything/2.0",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`GitHub organization "${org}" was not found (404).`);
      }
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        throw new Error(
          `GitHub API rate limit or permission error (${res.status}, remaining=${remaining ?? "unknown"}). Set GITHUB_TOKEN or run \`gh auth login\`.`,
        );
      }
      throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
    }

    const raw = (await res.json()) as unknown[];
    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const item of raw) {
      const parsed = GitHubRepoSummarySchema.safeParse(item);
      if (parsed.success) {
        collected.push(parsed.data);
      }
    }

    const matchingSoFar = filterOrgRepos(collected, { ...options, maxSizeMb });
    if (matchingSoFar.length >= options.limit || raw.length < 100) {
      break;
    }
  }

  const withoutSizeCap = filterOrgRepos(collected, { ...options, maxSizeMb: undefined, limit: Number.MAX_SAFE_INTEGER });
  const maxSizeKb = maxSizeMb * 1024;
  const skippedOversizedRepos = withoutSizeCap
    .filter((r) => (r.size ?? 0) > maxSizeKb)
    .map((r) => ({
      name: r.name,
      fullName: r.full_name,
      sizeMb: Number(((r.size ?? 0) / 1024).toFixed(1)),
    }));

  const candidates = filterOrgRepos(collected, { ...options, maxSizeMb });
  return { candidates, skippedOversizedRepos };
}

async function cloneWithTimeout(
  cloneUrl: string,
  destDir: string,
  timeoutMs: number,
  activeProcs: Set<ReturnType<typeof Bun.spawn>>,
): Promise<void> {
  const proc = Bun.spawn(["git", ...buildCloneArgs(cloneUrl, destDir)], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
    env: buildCloneEnv(),
  });
  activeProcs.add(proc);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore if already exited
    }
  }, timeoutMs);

  try {
    const exitCode = await proc.exited;
    if (timedOut) {
      throw new Error(`Clone timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git clone failed (exit ${exitCode}): ${stderr.trim()}`);
    }
  } finally {
    clearTimeout(timer);
    activeProcs.delete(proc);
  }
}

export async function scanOrganization(options: OrgScanOptions): Promise<OrgScanReport> {
  const token = resolveGitHubToken();
  if (!token) {
    options.onWarn?.(
      "No GitHub token found (GITHUB_TOKEN, GH_TOKEN, or `gh auth token`). Using unauthenticated GitHub API (60 req/hr limit).",
    );
  }

  const maxSizeMb = options.maxSizeMb ?? 150;
  options.onInfo?.(`Fetching repositories for organization "${options.org}"...`);
  const { candidates, skippedOversizedRepos } = await fetchOrgRepos(options.org, options, token);
  for (const skipped of skippedOversizedRepos) {
    options.onWarn?.(`Skipping oversized repo ${skipped.fullName} (${skipped.sizeMb} MB > --max-size-mb ${maxSizeMb}).`);
  }
  options.onInfo?.(`Found ${candidates.length} candidate repositories matching filters.`);

  const activeTempDirs = new Set<string>();
  const activeProcs = new Set<ReturnType<typeof Bun.spawn>>();
  const cleanupAll = () => {
    for (const proc of activeProcs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    activeProcs.clear();
    for (const dir of activeTempDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    activeTempDirs.clear();
  };

  const onSignal = (sig: NodeJS.Signals) => {
    cleanupAll();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const timeoutMs = options.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const budget = new BudgetLedger(10);
  const results: OrgScanRepoResult[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < candidates.length) {
      const idx = cursor++;
      const repo = candidates[idx];
      if (!repo) continue;

      let tempDir: string | null = null;
      let ingestCleanup: (() => void) | undefined;
      try {
        tempDir = mkdtempSync(join(tmpdir(), `distill-org-${repo.name.replace(/[^a-zA-Z0-9_-]/g, "_")}-`));
        activeTempDirs.add(tempDir);

        options.onInfo?.(`[${idx + 1}/${candidates.length}] Scanning ${repo.full_name}...`);
        await cloneWithTimeout(repo.clone_url, tempDir, timeoutMs, activeProcs);

        const ingest = await ingestRepository({
          source: tempDir,
          subpath: ".",
          gitDepth: 25,
          noGit: false,
          nameOverride: repo.name,
        });
        ingestCleanup = ingest.cleanup;

        const bundle = await buildSignalBundle({
          ingest,
          maxFiles: 20,
          maxCommits: 15,
          gitDepth: 25,
        });

        const signalDensityScore = computeSignalDensityScore(bundle);
        const topSignalFiles = bundle.files
          .filter((f) => f.bucket === "core_architecture")
          .slice(0, 3)
          .map((f) => f.path);

        const estMiner = budget.estimateCallCost("codex:default", bundle.totalTokens, 4096);
        const estDistillCostUsd = Number((estMiner * 1.5).toFixed(4));

        results.push({
          rank: 0,
          name: repo.name,
          fullName: repo.full_name,
          url: repo.html_url,
          stars: repo.stargazers_count,
          primaryLanguage: bundle.profile.primaryLanguage,
          maturity: bundle.profile.maturity.classification,
          topSignalFiles,
          signalDensityScore,
          totalFilesScanned: bundle.profile.totalFilesScanned,
          highSignalCommits: bundle.commits.length,
          bundleTokens: bundle.totalTokens,
          estDistillCostUsd,
          status: "scanned",
        });
      } catch (err) {
        results.push({
          rank: 0,
          name: repo.name,
          fullName: repo.full_name,
          url: repo.html_url,
          stars: repo.stargazers_count,
          primaryLanguage: repo.language?.toLowerCase() ?? "unknown",
          maturity: "hybrid",
          topSignalFiles: [],
          signalDensityScore: 0,
          totalFilesScanned: 0,
          highSignalCommits: 0,
          bundleTokens: 0,
          estDistillCostUsd: 0,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        ingestCleanup?.();
        if (tempDir) {
          activeTempDirs.delete(tempDir);
          if (existsSync(tempDir)) {
            rmSync(tempDir, { recursive: true, force: true });
          }
        }
      }
    }
  };

  try {
    const workerCount = Math.min(Math.max(1, options.concurrency), Math.max(1, candidates.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanupAll();
  }

  results.sort((a, b) => b.signalDensityScore - a.signalDensityScore || b.stars - a.stars);
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  const topRecommendations = results
    .filter((r) => r.status === "scanned")
    .slice(0, 3)
    .map((r) => `distill-anything ${r.url}`);

  const report: OrgScanReport = {
    version: "2.0",
    org: options.org,
    scannedAt: new Date().toISOString(),
    filters: {
      limit: options.limit,
      lang: options.lang ?? null,
      minStars: options.minStars,
      maxSizeMb,
      includeForks: options.includeForks,
      includeArchived: options.includeArchived,
    },
    authenticated: Boolean(token),
    totalCandidatesFound: candidates.length,
    repos: results,
    topRecommendations,
  };
  if (skippedOversizedRepos.length > 0) {
    report.skippedOversizedRepos = skippedOversizedRepos;
  }
  return report;
}

/** Formats a clean terminal table for an OrgScanReport. */
export function formatOrgScanTable(report: OrgScanReport): string {
  const lines: string[] = [
    "",
    `=== distill-anything scan-org: ${report.org} (${report.repos.length} repos) ===`,
    "",
  ];

  const headers = ["Rank", "Repo", "Language", "Maturity", "Top Signal Files", "Signal Score", "Est. Distill Cost"];
  const rows = report.repos.map((r) => [
    String(r.rank),
    r.name,
    r.primaryLanguage,
    r.status === "failed" ? "failed" : r.maturity,
    r.status === "failed"
      ? (r.error ?? "error").slice(0, 36)
      : r.topSignalFiles.slice(0, 2).join(", ") || "-",
    r.signalDensityScore.toFixed(2),
    `$${r.estDistillCostUsd.toFixed(4)}`,
  ]);

  const widths = headers.map((h, col) =>
    Math.min(44, Math.max(h.length, ...rows.map((row) => (row[col] ?? "").length))),
  );

  const pad = (val: string, w: number) => (val.length > w ? `${val.slice(0, w - 1)}…` : val.padEnd(w));
  const formatRow = (cols: string[]) => cols.map((c, i) => pad(c, widths[i] ?? 10)).join(" | ");

  lines.push(formatRow(headers));
  lines.push(widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const row of rows) {
    lines.push(formatRow(row));
  }

  if (report.topRecommendations.length > 0) {
    lines.push("", "Top 3 Recommended Commands:");
    for (const cmd of report.topRecommendations) {
      lines.push(`  ${cmd}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
