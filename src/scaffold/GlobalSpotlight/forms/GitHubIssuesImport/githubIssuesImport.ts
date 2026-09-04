/** Canonical owner/repository pair used by the GitHub sync adapter. */
export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
}

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseGitHubRepo(input: string): ParsedGitHubRepo | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(/^git@github\.com:(.+)$/i);
  let path = sshMatch?.[1] ?? trimmed;

  if (!sshMatch) {
    try {
      const url = new URL(trimmed);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      path = url.pathname;
    } catch {
      path = trimmed.replace(/^github\.com\//i, "");
    }
  }

  path = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!GITHUB_REPO_PATTERN.test(path)) return null;

  const [owner, repo] = path.split("/");
  return owner && repo ? { owner, repo } : null;
}

export function formatGitHubRepoInput(input?: string): string {
  if (!input) return "";
  const parsed = parseGitHubRepo(input);
  return parsed ? `${parsed.owner}/${parsed.repo}` : "";
}

export function createProjectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "github-issues";
}

export function createWorkItemPrefix(name: string): string {
  const prefix = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return prefix ? prefix.slice(0, 3).padEnd(3, "X") : "GHI";
}
