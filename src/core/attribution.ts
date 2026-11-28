export interface GitHubRepoRef {
  owner: string;
  repo: string;
  slug: string;
  url: string;
}

const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/i;
const GITHUB_SSH_RE = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i;

/**
 * Extracts GitHub owner/repo metadata from a repository source string.
 * Returns null for local paths or non-GitHub URLs.
 */
export function extractGitHubRepo(source: string): GitHubRepoRef | null {
  const trimmed = source.trim();
  const match = trimmed.match(GITHUB_HTTPS_RE) ?? trimmed.match(GITHUB_SSH_RE);
  if (!match?.[1] || !match?.[2]) {
    return null;
  }
  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    slug: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

/** Returns `@owner` when `source` is a GitHub repository, or `null` otherwise. */
export function formatGitHubOwnerMention(source: string): string | null {
  const ref = extractGitHubRepo(source);
  return ref ? `@${ref.owner}` : null;
}

/** Formats the SKILL.md Source line with GitHub link and `@owner` attribution when available. */
export function formatSourceAttribution(source: string, commitSha: string | null): string {
  const commitShort = commitSha ? commitSha.slice(0, 8) : "no-git";
  const ref = extractGitHubRepo(source);
  if (!ref) {
    return `\`${source}\` @ \`${commitShort}\``;
  }
  return `[\`${ref.slug}\`](${ref.url}) @ \`${commitShort}\` (by [@${ref.owner}](https://github.com/${ref.owner}))`;
}

/** Collects deduplicated `@owner` mentions from a list of source strings. */
export function collectOwnerMentions(sources: string[]): string[] {
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const src of sources) {
    const mention = formatGitHubOwnerMention(src);
    if (mention && !seen.has(mention.toLowerCase())) {
      seen.add(mention.toLowerCase());
      mentions.push(mention);
    }
  }
  return mentions;
}
