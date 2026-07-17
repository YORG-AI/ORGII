export interface GitHubPillReference {
  url: string;
  displayName: string;
  iconType: "repo" | "issue" | "pr";
}

/** Parse a pasted GitHub repository, issue, or pull-request URL. */
export function parseGitHubPillUrl(value: string): GitHubPillReference | null {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    (url.hostname !== "github.com" && url.hostname !== "www.github.com")
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, rawRepo, resourceType, resourceNumber, ...rest] = segments;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!owner || !repo || rest.length > 0) return null;

  const canonicalRepoUrl = `https://github.com/${owner}/${repo}`;
  if (segments.length === 2) {
    return {
      url: canonicalRepoUrl,
      displayName: `${owner}/${repo}`,
      iconType: "repo",
    };
  }

  if (
    segments.length !== 4 ||
    (resourceType !== "issues" && resourceType !== "pull") ||
    !/^\d+$/.test(resourceNumber)
  ) {
    return null;
  }

  return {
    url: `${canonicalRepoUrl}/${resourceType}/${resourceNumber}`,
    displayName: `${owner}/${repo}#${resourceNumber}`,
    iconType: resourceType === "pull" ? "pr" : "issue",
  };
}

export function isGitHubPillUrl(value: string): boolean {
  return parseGitHubPillUrl(value) !== null;
}
