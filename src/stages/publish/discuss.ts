import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { extractGitHubRepo, formatGitHubOwnerMention } from "../../core/attribution";
import { DEFAULT_AWESOME_REPO, validateSkillDirForPublish } from "./publisher";

export class DiscussError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscussError";
  }
}

export type DiscussTarget = "auto" | "source" | "awesome";

export interface DiscussionCategory {
  id: string;
  name: string;
  slug: string;
}

export interface DiscussResult {
  status: "created" | "dry_run" | "browser_opened";
  targetRepo: string;
  title: string;
  body: string;
  url: string;
  category?: string;
  discussionNumber?: number;
  mentionedOwners: string[];
}

export type GraphqlRunner = (
  query: string,
  variables: Record<string, string>,
) => Record<string, unknown>;

export type BrowserOpener = (url: string) => void;

const REPO_DISCUSSIONS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    hasDiscussionsEnabled
    discussionCategories(first: 20) {
      nodes {
        id
        name
        slug
      }
    }
  }
}
`;

const CREATE_DISCUSSION_MUTATION = `
mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: {
    repositoryId: $repositoryId,
    categoryId: $categoryId,
    title: $title,
    body: $body
  }) {
    discussion {
      number
      url
    }
  }
}
`;

function defaultGraphqlRunner(
  query: string,
  variables: Record<string, string>,
): Record<string, unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push("-F", `${key}=${value}`);
  }
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    env: { ...process.env, GH_PAGER: "cat" },
  });
  if (res.error) {
    throw new DiscussError(`Failed to run gh CLI: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const errText = (res.stderr || res.stdout || "").trim();
    throw new DiscussError(`GitHub GraphQL request failed: ${errText || `exit ${res.status}`}`);
  }
  try {
    // SAFETY: `gh api graphql` always returns a JSON object when exiting with code 0.
    return JSON.parse(res.stdout) as Record<string, unknown>;
  } catch (err) {
    throw new DiscussError(
      `Invalid JSON from gh api graphql: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function defaultBrowserOpener(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    throw new DiscussError(
      `Failed to open browser (${cmd}): ${res.error?.message ?? (res.stderr || "").trim()}`,
    );
  }
}

function extractOwnerMentionsFromSkillMd(skillMd: string, source: string): string[] {
  const seen = new Set<string>();
  const mentions: string[] = [];

  const fromSource = formatGitHubOwnerMention(source);
  if (fromSource) {
    seen.add(fromSource.toLowerCase());
    mentions.push(fromSource);
  }

  // Also pick up @owner mentions from SKILL.md (e.g. merged cross-repo playbooks)
  const mentionMatches = skillMd.matchAll(/(?:^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g);
  for (const m of mentionMatches) {
    if (!m[1]) continue;
    const tag = `@${m[1]}`;
    if (!seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      mentions.push(tag);
    }
  }

  return mentions;
}

function extractPatternTableLines(skillMd: string): string[] {
  return skillMd
    .split("\n")
    .filter((line) => line.startsWith("|") || line.startsWith("### `"));
}

function normalizeRepoSlug(repo: string): string {
  const ref = extractGitHubRepo(repo);
  if (ref) return ref.slug;
  const trimmed = repo.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return trimmed;
  }
  throw new DiscussError(
    `Invalid GitHub repository "${repo}". Expected "owner/repo" or a GitHub URL.`,
  );
}

export function buildNewDiscussionUrl(params: {
  targetRepo: string;
  title: string;
  body: string;
  category?: string | undefined;
}): string {
  const base = `https://github.com/${params.targetRepo}/discussions/new`;
  const search = new URLSearchParams();
  search.set("title", params.title);
  // Keep URL body bounded to avoid browser/server URL length limits
  const boundedBody =
    params.body.length > 3500
      ? `${params.body.slice(0, 3500)}\n\n_(Truncated for URL preview — full playbook in SKILL.md)_`
      : params.body;
  search.set("body", boundedBody);
  if (params.category) {
    search.set("category", params.category.toLowerCase().replace(/\s+/g, "-"));
  }
  return `${base}?${search.toString()}`;
}

export function buildDiscussionContent(params: {
  skillDir: string;
  awesomeRepo?: string | undefined;
}): {
  skillSlug: string;
  source: string;
  title: string;
  body: string;
  mentionedOwners: string[];
} {
  const { absDir, report } = validateSkillDirForPublish(params.skillDir);
  const skillMd = readFileSync(join(absDir, "SKILL.md"), "utf8");
  const { profile } = report;
  const sourceRef = extractGitHubRepo(profile.source);
  const mentionedOwners = extractOwnerMentionsFromSkillMd(skillMd, profile.source);
  const commitShort = profile.commitSha ? profile.commitSha.slice(0, 8) : "no-git";
  const awesomeRepo = params.awesomeRepo?.trim() || DEFAULT_AWESOME_REPO;

  const title = `Engineering Playbook: ${profile.repoName} (${report.patternsKept} verified patterns)`;

  const creditLine =
    mentionedOwners.length > 0
      ? `> Distilled with credit to ${mentionedOwners.join(", ")} from ${
          sourceRef ? `[\`${sourceRef.slug}\`](${sourceRef.url})` : `\`${profile.source}\``
        } @ \`${commitShort}\``
      : `> Distilled from \`${profile.source}\` @ \`${commitShort}\``;

  const tableLines = extractPatternTableLines(skillMd);
  const patternsSection =
    tableLines.length > 0
      ? ["### Distilled Patterns", "", ...tableLines]
      : ["### Summary", "", `Contains ${report.patternsKept} verified engineering patterns.`];

  const awesomeSkillUrl = `https://github.com/${normalizeRepoSlug(awesomeRepo)}/tree/main/skills/${profile.skillSlug}`;

  const bodyLines = [
    `## ${profile.repoName} Engineering Playbook`,
    "",
    creditLine,
    "",
    `- **Primary Language**: \`${profile.primaryLanguage}\``,
    `- **Maturity**: \`${profile.maturity.classification}\``,
    `- **Verified Patterns**: ${report.patternsKept} (grounding: \`${report.groundingMode}\`)`,
    "",
    ...patternsSection,
    "",
    "---",
    `Browse this skill in Awesome Distilled Skills: ${awesomeSkillUrl}`,
    `Distilled with [distill-anything](https://github.com/imMamdouhaboammar/distill-anything)`,
  ];

  return {
    skillSlug: profile.skillSlug,
    source: profile.source,
    title,
    body: bodyLines.join("\n"),
    mentionedOwners,
  };
}

function selectDiscussionCategory(
  nodes: DiscussionCategory[],
  preferred?: string,
): DiscussionCategory {
  if (nodes.length === 0) {
    throw new DiscussError("Repository has no discussion categories configured.");
  }
  if (preferred) {
    const target = preferred.trim().toLowerCase();
    const matched = nodes.find(
      (n) => n.name.toLowerCase() === target || n.slug.toLowerCase() === target,
    );
    if (matched) return matched;
  }
  const prioritySlugs = ["show-and-tell", "general", "ideas", "announcements"];
  for (const slug of prioritySlugs) {
    const found = nodes.find((n) => n.slug.toLowerCase() === slug);
    if (found) return found;
  }
  const first = nodes[0];
  if (!first) {
    throw new DiscussError("Repository has no discussion categories configured.");
  }
  return first;
}

function resolveCandidateRepos(params: {
  target: DiscussTarget;
  targetRepo?: string | undefined;
  source: string;
  awesomeRepo?: string | undefined;
}): string[] {
  if (params.targetRepo) {
    return [normalizeRepoSlug(params.targetRepo)];
  }
  const sourceRef = extractGitHubRepo(params.source);
  const awesomeSlug = normalizeRepoSlug(params.awesomeRepo?.trim() || DEFAULT_AWESOME_REPO);

  if (params.target === "source") {
    if (!sourceRef) {
      throw new DiscussError(
        `Cannot open discussion on source repo: "${params.source}" is not a GitHub repository.`,
      );
    }
    return [sourceRef.slug];
  }
  if (params.target === "awesome") {
    return [awesomeSlug];
  }
  // auto: prefer source repo (to notify owner directly), fallback to awesome repo
  return sourceRef && sourceRef.slug.toLowerCase() !== awesomeSlug.toLowerCase()
    ? [sourceRef.slug, awesomeSlug]
    : [awesomeSlug];
}

export function openSkillDiscussion(params: {
  skillDir: string;
  target?: DiscussTarget | undefined;
  targetRepo?: string | undefined;
  category?: string | undefined;
  awesomeRepo?: string | undefined;
  dryRun?: boolean | undefined;
  openBrowser?: boolean | undefined;
  graphqlRunner?: GraphqlRunner | undefined;
  browserOpener?: BrowserOpener | undefined;
}): DiscussResult {
  const target = params.target ?? "auto";
  const content = buildDiscussionContent({
    skillDir: params.skillDir,
    awesomeRepo: params.awesomeRepo,
  });

  const candidates = resolveCandidateRepos({
    target,
    targetRepo: params.targetRepo,
    source: content.source,
    awesomeRepo: params.awesomeRepo,
  });
  const primaryRepo = candidates[0]!;
  const previewUrl = buildNewDiscussionUrl({
    targetRepo: primaryRepo,
    title: content.title,
    body: content.body,
    category: params.category,
  });

  if (params.dryRun) {
    return {
      status: "dry_run",
      targetRepo: primaryRepo,
      title: content.title,
      body: content.body,
      url: previewUrl,
      mentionedOwners: content.mentionedOwners,
    };
  }

  if (params.openBrowser) {
    const opener = params.browserOpener ?? defaultBrowserOpener;
    opener(previewUrl);
    return {
      status: "browser_opened",
      targetRepo: primaryRepo,
      title: content.title,
      body: content.body,
      url: previewUrl,
      mentionedOwners: content.mentionedOwners,
    };
  }

  const runGraphql = params.graphqlRunner ?? defaultGraphqlRunner;
  const failures: string[] = [];

  for (const repoSlug of candidates) {
    const [owner, name] = repoSlug.split("/");
    if (!owner || !name) continue;

    const repoData = runGraphql(REPO_DISCUSSIONS_QUERY, { owner, name }) as {
      data?: {
        repository?: {
          id?: string;
          hasDiscussionsEnabled?: boolean;
          discussionCategories?: { nodes?: DiscussionCategory[] };
        } | null;
      };
    };

    const repo = repoData.data?.repository;
    if (!repo?.id) {
      failures.push(`${repoSlug}: repository not found or inaccessible`);
      continue;
    }
    if (!repo.hasDiscussionsEnabled) {
      failures.push(`${repoSlug}: GitHub Discussions are disabled`);
      continue;
    }

    const categories = repo.discussionCategories?.nodes ?? [];
    const selected = selectDiscussionCategory(categories, params.category);

    const created = runGraphql(CREATE_DISCUSSION_MUTATION, {
      repositoryId: repo.id,
      categoryId: selected.id,
      title: content.title,
      body: content.body,
    }) as {
      data?: {
        createDiscussion?: {
          discussion?: { number?: number; url?: string };
        };
      };
    };

    const discussion = created.data?.createDiscussion?.discussion;
    if (!discussion?.url) {
      throw new DiscussError(`createDiscussion did not return a discussion URL for ${repoSlug}.`);
    }

    const result: DiscussResult = {
      status: "created",
      targetRepo: repoSlug,
      title: content.title,
      body: content.body,
      url: discussion.url,
      category: selected.name,
      mentionedOwners: content.mentionedOwners,
    };
    if (discussion.number !== undefined) {
      result.discussionNumber = discussion.number;
    }
    return result;
  }

  throw new DiscussError(
    `Could not create GitHub Discussion (${failures.join("; ")}). Enable Discussions on the target repo or pass --open to open: ${previewUrl}`,
  );
}
