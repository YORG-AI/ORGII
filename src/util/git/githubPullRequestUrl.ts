/**
 * github.com pull-request URL detection shared by chat link handling and the
 * turn-metadata footer. Host-strict on purpose: GitHub Enterprise hosts are
 * not routed through the in-app PR flows.
 */

const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/i;

export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/** `https://github.com/owner/repo/pull/851[/files?…#…]` → `{ owner, repo, number }`. */
export function parseGitHubPullRequestUrl(
  url: string
): GitHubPullRequestRef | null {
  const match = GITHUB_PULL_REQUEST_URL_PATTERN.exec(url.trim());
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { owner: match[1], repo: match[2], number };
}

export function isGitHubPullRequestUrl(url: string): boolean {
  return parseGitHubPullRequestUrl(url) !== null;
}
