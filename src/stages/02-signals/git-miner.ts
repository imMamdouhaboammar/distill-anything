import type { SignalCommit } from "../../schemas/signal-bundle";
import { countTokens, truncateToTokens } from "../../core/tokens";

const HIGH_SIGNAL_REGEX =
  /\b(perf|optimi[sz]|race|deadlock|lock-?free|zero-?copy|memory|leak|cache|concurren|async|refactor|architect|invariant|edge[- ]case|retry|backpressure|stream|pool|alloc|latency|throughput|batch|rbac|auth|tenant|namespace|routing|schema|migration|timeout|isolation|fallback|idempoten|circuit[- ]breaker|quota)\b/i;

const HIGH_WEIGHT_REGEX =
  /\b(perf|optimi[sz]|race|deadlock|lock-?free|zero-?copy|memory|leak|concurren|invariant|backpressure|alloc|latency|throughput|rbac|isolation|idempoten|circuit[- ]breaker|timeout)\b/gi;

const VERSION_BUMP_REGEX = /^(chore\(release\)|bump version|release v?\d)/i;

const FALLBACK_EXCLUDE_REGEX =
  /^(?:chore(?:\([^)]*\))?:\s*(?:release|bump|format|lint|merge)\b|chore\(release\)|(?:bump|merge|format|lint)\b)/i;

const EXCLUDED_DIFF_FILE_REGEX =
  /(?:package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|\.snap(?:\.|$)|\.generated\.|\.min\.(?:js|css)$|\.bundle\.js$|(?:^|\/)(?:dist|build|\.next)\/)/i;

function runGit(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return "";
  return new TextDecoder().decode(proc.stdout);
}

function stripLockfileHunks(diff: string): string {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter((sec) => !EXCLUDED_DIFF_FILE_REGEX.test(sec.split("\n", 1)[0] ?? ""))
    .join("");
}

function parseNumstatLine(line: string): { ins: number; del: number; filePath: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const tabParts = trimmed.split("\t");
  const parts = tabParts.length >= 3 ? tabParts : trimmed.split(/\s+/);
  if (parts.length < 3) return null;
  const ins = Number(parts[0]) || 0;
  const del = Number(parts[1]) || 0;
  const filePath = parts.slice(2).join("\t");
  return { ins, del, filePath };
}

/** Mines high-signal architectural and performance commits from git history. */
export function mineHighSignalCommits(params: {
  repoRoot: string;
  gitDepth: number;
  maxCommits: number;
  tokenBudget: number;
  coreFilePaths: Set<string>;
}): SignalCommit[] {
  if (params.maxCommits <= 0 || params.tokenBudget <= 0) return [];

  const logRaw = runGit(
    ["log", `-n`, String(params.gitDepth), "--no-merges", "--format=%H%x1f%s%x1f%ad%x1f%b%x1e", "--date=short"],
    params.repoRoot,
  );
  if (!logRaw.trim()) return [];

  interface ScannedCommit {
    sha: string;
    subject: string;
    date: string;
    body: string;
    recencyIndex: number;
  }

  interface ScoredCommit {
    sha: string;
    subject: string;
    date: string;
    body: string;
    score: number;
    recencyIndex: number;
  }

  const scannedCommits: ScannedCommit[] = [];
  const candidates: ScoredCommit[] = [];
  let totalScanned = 0;
  let keywordMatches = 0;
  let skippedNoKeyword = 0;
  let skippedSizeOrSync = 0;

  for (const record of logRaw.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha = "", subject = "", date = "", body = ""] = trimmed.split("\x1f");
    if (!sha || VERSION_BUMP_REGEX.test(subject)) continue;

    const recencyIndex = totalScanned;
    totalScanned += 1;
    scannedCommits.push({ sha, subject, date, body, recencyIndex });

    const combined = `${subject}\n${body}`;
    if (!HIGH_SIGNAL_REGEX.test(combined)) {
      skippedNoKeyword += 1;
      continue;
    }
    keywordMatches += 1;

    const numstat = runGit(["show", "--numstat", "--format=", sha], params.repoRoot);
    let filesChanged = 0;
    let totalLinesChanged = 0;
    let touchesCore = false;

    for (const line of numstat.split("\n")) {
      const parsed = parseNumstatLine(line);
      if (!parsed) continue;
      filesChanged += 1;
      totalLinesChanged += parsed.ins + parsed.del;
      if (params.coreFilePaths.has(parsed.filePath)) {
        touchesCore = true;
      }
    }

    if (filesChanged > 15 || totalLinesChanged > 1200) {
      skippedSizeOrSync += 1;
      continue;
    }

    const highMatches = combined.match(HIGH_WEIGHT_REGEX)?.length ?? 0;
    let score = 1.0 + highMatches * 1.5;
    if (body.trim().length > 80) score += 3.0;
    if (touchesCore) score += 2.0;

    candidates.push({ sha, subject, date, body: body.trim(), score, recencyIndex });
  }

  let fallbackActive = false;
  let fallbackPoolCount = 0;
  let commitLimit = params.maxCommits;

  if (totalScanned > 0 && keywordMatches === 0) {
    fallbackActive = true;
    commitLimit = Math.min(5, params.maxCommits);

    for (const c of scannedCommits) {
      if (FALLBACK_EXCLUDE_REGEX.test(c.subject)) continue;

      const numstat = runGit(["show", "--numstat", "--format=", c.sha], params.repoRoot);
      let filesChanged = 0;
      let totalLinesChanged = 0;
      const coreFilesTouched = new Set<string>();

      for (const line of numstat.split("\n")) {
        const parsed = parseNumstatLine(line);
        if (!parsed) continue;
        if (EXCLUDED_DIFF_FILE_REGEX.test(parsed.filePath)) continue;
        filesChanged += 1;
        totalLinesChanged += parsed.ins + parsed.del;
        if (params.coreFilePaths.has(parsed.filePath)) {
          coreFilesTouched.add(parsed.filePath);
        }
      }

      if (coreFilesTouched.size === 0) continue;
      if (filesChanged > 10 || totalLinesChanged < 15 || totalLinesChanged > 350) continue;

      let score = coreFilesTouched.size * 2.0;
      if (c.body.trim().length > 40) score += 2.0;

      candidates.push({
        sha: c.sha,
        subject: c.subject,
        date: c.date,
        body: c.body.trim(),
        score,
        recencyIndex: c.recencyIndex,
      });
    }
    fallbackPoolCount = candidates.length;
  }

  candidates.sort((a, b) => b.score - a.score || a.recencyIndex - b.recencyIndex);

  const selected: SignalCommit[] = [];
  let usedTokens = 0;

  for (const c of candidates) {
    if (selected.length >= commitLimit) break;
    const rawDiff = runGit(["show", "--stat", "-U5", "--format=", c.sha], params.repoRoot);
    const cleanedDiff = stripLockfileHunks(rawDiff).trim();
    if (!cleanedDiff) continue;

    const remaining = params.tokenBudget - usedTokens;
    if (remaining < 200) break;

    const { text: diff } = truncateToTokens(cleanedDiff, Math.min(remaining, 2500));
    const tokenCount = countTokens(diff);
    if (tokenCount <= 0) continue;

    selected.push({
      sha: c.sha,
      date: c.date,
      subject: c.subject,
      body: c.body,
      score: c.score,
      tokenCount,
      diff,
    });
    usedTokens += tokenCount;
  }

  if (fallbackActive) {
    console.warn(
      `[git-miner] 0 keyword matches; fallback selected ${selected.length}/${fallbackPoolCount} commits touching Bucket A files`,
    );
  } else if (selected.length === 0 && totalScanned > 0) {
    console.warn(
      `[git-miner] 0 commits selected (${totalScanned} scanned: ${skippedSizeOrSync} skipped due to >15 files / >1200 lines or mirror-sync, ${skippedNoKeyword} lacked signal keywords).`,
    );
  }

  return selected;
}
