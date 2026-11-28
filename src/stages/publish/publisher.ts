import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DistillReportSchema, type DistillReport } from "../../schemas/report";
import type { DistillConfig } from "../../core/config";

export const DEFAULT_AWESOME_REPO = "imMamdouhaboammar/awesome-distilled-skills";

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

export interface PublishResult {
  status: "published" | "up_to_date" | "skipped";
  repo: string;
  branch: string;
  skillSlug: string;
  patternsKept: number;
  commitSha?: string;
  reason?: string;
}

export function resolvePublishRepoUrl(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed) {
    throw new PublishError("Publish repository cannot be empty.");
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("git@") ||
    existsSync(trimmed)
  ) {
    return trimmed;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  throw new PublishError(
    `Invalid publish repository "${repo}". Expected "owner/repo", a Git URL, or a local git path.`,
  );
}

export function resolvePublishSettings(params: {
  cliPublish?: boolean | undefined;
  cliRepo?: string | undefined;
  cliBranch?: string | undefined;
  config: DistillConfig | null;
}): {
  shouldPublish: boolean;
  repo: string | undefined;
  branch: string;
} {
  const envRepo = process.env.DISTILL_PUBLISH_REPO?.trim() || undefined;
  const envBranch = process.env.DISTILL_PUBLISH_BRANCH?.trim() || undefined;

  const repo = params.cliRepo ?? envRepo ?? params.config?.publishRepo ?? DEFAULT_AWESOME_REPO;
  const branch = params.cliBranch ?? envBranch ?? params.config?.publishBranch ?? "main";

  if (params.cliPublish === false) {
    return { shouldPublish: false, repo, branch };
  }
  if (params.cliPublish === true) {
    return { shouldPublish: true, repo, branch };
  }

  const autoEnabled = params.config?.autoPublish ?? true;
  return {
    shouldPublish: autoEnabled,
    repo,
    branch,
  };
}

function runGit(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    status: res.status ?? 1,
  };
}

function ensureWorkTree(repoUrl: string, branch: string, workDir: string): void {
  if (existsSync(join(workDir, ".git"))) {
    const fetch = runGit(["fetch", "origin", branch, "--depth", "1"], workDir);
    if (fetch.status === 0) {
      const checkout = runGit(["checkout", "-B", branch, `origin/${branch}`], workDir);
      if (checkout.status !== 0) {
        throw new PublishError(`git checkout ${branch} failed: ${checkout.stderr}`);
      }
      return;
    }
    rmSync(workDir, { recursive: true, force: true });
  }

  mkdirSync(workDir, { recursive: true });
  const clone = runGit(["clone", "--depth", "1", "--branch", branch, repoUrl, workDir], workDir);
  if (clone.status !== 0) {
    const fallback = runGit(["clone", repoUrl, workDir], workDir);
    if (fallback.status !== 0) {
      throw new PublishError(`Failed to clone ${repoUrl}: ${clone.stderr || fallback.stderr}`);
    }
  }
}

export function validateSkillDirForPublish(skillDir: string): {
  absDir: string;
  report: DistillReport;
} {
  const absDir = resolve(skillDir);
  const skillMdPath = join(absDir, "SKILL.md");
  const reportPath = join(absDir, "distill-report.json");

  if (!existsSync(skillMdPath)) {
    throw new PublishError(`Missing SKILL.md in ${absDir}`);
  }
  if (!existsSync(reportPath)) {
    throw new PublishError(`Missing distill-report.json in ${absDir}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (err) {
    throw new PublishError(`Invalid distill-report.json in ${absDir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const report = DistillReportSchema.parse(parsed);
  if (report.patternsKept === 0) {
    throw new PublishError(`Skill "${report.profile.skillSlug}" has 0 kept patterns; refusing to publish.`);
  }

  return { absDir, report };
}

export function publishSkillToAwesomeRepo(params: {
  skillDir: string;
  repo: string;
  branch?: string | undefined;
  workDir?: string | undefined;
}): PublishResult {
  const branch = params.branch?.trim() || "main";
  const repoUrl = resolvePublishRepoUrl(params.repo);
  const { absDir, report } = validateSkillDirForPublish(params.skillDir);
  const skillSlug = report.profile.skillSlug;

  const safeKey = params.repo.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const workDir =
    params.workDir ?? join(homedir(), ".cache", "distill-anything", "awesome-repos", safeKey);

  ensureWorkTree(repoUrl, branch, workDir);

  const destSkillDir = join(workDir, "skills", skillSlug);
  rmSync(destSkillDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "skills"), { recursive: true });
  cpSync(absDir, destSkillDir, { recursive: true });

  const indexScript = join(workDir, "scripts", "build-index.ts");
  if (existsSync(indexScript)) {
    const bunExe = process.execPath || "bun";
    const indexRes = spawnSync(bunExe, ["run", indexScript], {
      cwd: workDir,
      encoding: "utf8",
    });
    if (indexRes.status !== 0) {
      throw new PublishError(
        `Awesome repo index rebuild failed: ${(indexRes.stderr || indexRes.stdout || "").trim()}`,
      );
    }
  }

  const statusRes = runGit(["status", "--porcelain"], workDir);
  if (statusRes.status !== 0) {
    throw new PublishError(`git status failed: ${statusRes.stderr}`);
  }
  if (!statusRes.stdout) {
    return {
      status: "up_to_date",
      repo: params.repo,
      branch,
      skillSlug,
      patternsKept: report.patternsKept,
    };
  }

  const addRes = runGit(["add", "-A"], workDir);
  if (addRes.status !== 0) {
    throw new PublishError(`git add failed: ${addRes.stderr}`);
  }

  const msg = `chore(skills): publish ${skillSlug} (${report.patternsKept} patterns)`;
  const commitRes = runGit(["commit", "-m", msg], workDir);
  if (commitRes.status !== 0) {
    throw new PublishError(`git commit failed: ${commitRes.stderr}`);
  }

  const shaRes = runGit(["rev-parse", "HEAD"], workDir);
  const pushRes = runGit(["push", "origin", `HEAD:${branch}`], workDir);
  if (pushRes.status !== 0) {
    throw new PublishError(`git push failed: ${pushRes.stderr}`);
  }

  const result: PublishResult = {
    status: "published",
    repo: params.repo,
    branch,
    skillSlug,
    patternsKept: report.patternsKept,
  };
  if (shaRes.stdout) {
    result.commitSha = shaRes.stdout;
  }
  return result;
}
