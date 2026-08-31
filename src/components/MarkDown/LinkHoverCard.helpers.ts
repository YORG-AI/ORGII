import type { GitHubPrDetailTabData } from "@src/types/githubDetail";
import {
  type GitHubPullRequestRef,
  parseGitHubPullRequestUrl,
} from "@src/util/git/githubPullRequestUrl";
import { resolveGithubRepoFullName } from "@src/util/git/githubRemote";
import { normalizeHttpUrlCandidate } from "@src/util/url/validation";

export interface HttpLinkPreview {
  url: string;
  host: string;
  displayUrl: string;
}

function readString(
  source: Record<string, unknown> | null | undefined,
  key: string
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function readNestedString(
  source: Record<string, unknown>,
  parentKey: string,
  childKey: string
): string | undefined {
  const parent = source[parentKey];
  if (!parent || typeof parent !== "object") return undefined;
  return readString(parent as Record<string, unknown>, childKey);
}

function readNumber(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getPrStatus(detail: Record<string, unknown>): string {
  if (detail.merged === true) return "merged";
  if (detail.draft === true) return "draft";
  return readString(detail, "state")?.toLowerCase() === "closed"
    ? "closed"
    : "open";
}

export function remoteUrlsMatchGitHubPullRequest(
  pullRequest: GitHubPullRequestRef,
  remoteUrls: readonly (string | null | undefined)[]
): boolean {
  const expected = `${pullRequest.owner}/${pullRequest.repo}`.toLowerCase();
  return remoteUrls.some((remoteUrl) => {
    if (!remoteUrl) return false;
    return resolveGithubRepoFullName([remoteUrl])?.toLowerCase() === expected;
  });
}

export function createGitHubPrTabDataFromLink(params: {
  url: string;
  repoPath: string;
  repoId?: string;
  detail: Record<string, unknown>;
}): GitHubPrDetailTabData | null {
  const pullRequest = parseGitHubPullRequestUrl(params.url);
  if (!pullRequest) return null;

  return {
    prNumber: pullRequest.number,
    prTitle:
      readString(params.detail, "title") ??
      `${pullRequest.owner}/${pullRequest.repo}`,
    prUrl: readString(params.detail, "html_url") ?? params.url,
    prStatus: getPrStatus(params.detail),
    headBranch: readNestedString(params.detail, "head", "ref") ?? "",
    baseBranch: readNestedString(params.detail, "base", "ref"),
    updatedAt: readString(params.detail, "updated_at"),
    additions: readNumber(params.detail, "additions"),
    deletions: readNumber(params.detail, "deletions"),
    repoPath: params.repoPath,
    repoId: params.repoId,
  };
}

const DISPLAY_URL_MAX_LENGTH = 88;

function formatDisplayUrl(url: string): string {
  const withoutProtocol = url.replace(/^https?:\/\//i, "");
  const compact = withoutProtocol.endsWith("/")
    ? withoutProtocol.slice(0, -1)
    : withoutProtocol;
  if (compact.length <= DISPLAY_URL_MAX_LENGTH) return compact;
  return `${compact.slice(0, DISPLAY_URL_MAX_LENGTH - 1).trimEnd()}…`;
}

export function getHttpLinkPreview(candidate: string): HttpLinkPreview | null {
  const url = normalizeHttpUrlCandidate(candidate);
  if (!url) return null;

  const parsed = new URL(url);
  return {
    url,
    host: parsed.host.replace(/^www\./i, ""),
    displayUrl: formatDisplayUrl(url),
  };
}
