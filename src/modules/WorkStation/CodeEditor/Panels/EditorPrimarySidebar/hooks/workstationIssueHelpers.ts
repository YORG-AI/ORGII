import type { GitHubIssue } from "@src/api/tauri/github";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

export type IssueSectionLoadState = "idle" | "loading" | "ready" | "error";

export const CLOSED_ISSUES_COLLAPSED_BY_DEFAULT = true;

export function shouldLoadClosedIssuesOnToggle(
  collapsed: boolean,
  loadState: IssueSectionLoadState
): boolean {
  return collapsed && (loadState === "idle" || loadState === "error");
}

export function formatIssueStateLabel(state: string): string {
  if (state === "open") return "Open";
  if (state === "closed") return "Closed";
  return state;
}

export function filterIssuesByQuery(
  issues: GitHubIssue[],
  query: string
): GitHubIssue[] {
  if (!query.trim()) return issues;
  const q = query.trim().toLowerCase();
  return issues.filter(
    (issue) =>
      issue.title.toLowerCase().includes(q) ||
      String(issue.number).includes(q) ||
      `#${issue.number}`.includes(q) ||
      issue.labels.some((l) => l.name.toLowerCase().includes(q)) ||
      issue.user.login.toLowerCase().includes(q)
  );
}

export function sortIssues(
  issues: GitHubIssue[],
  by: "updated" | "created" | "number"
): GitHubIssue[] {
  return [...issues].sort((a, b) => {
    if (by === "number") return b.number - a.number;
    if (by === "created")
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
}

/** Convert a GitHub hex color (e.g. "d73a4a") to an inline style object. */
export function getLabelColorStyle(hexColor: string): {
  backgroundColor: string;
  color: string;
} {
  const r = parseInt(hexColor.slice(0, 2), 16);
  const g = parseInt(hexColor.slice(2, 4), 16);
  const b = parseInt(hexColor.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return {
    backgroundColor: `#${hexColor}`,
    color: luminance > 0.5 ? "#000000" : "#ffffff",
  };
}

export function formatTimeAgo(dateString: string): string {
  return formatRelativeTime(dateString, "issue");
}

export function parseGithubIssueNumber(url: string): number | null {
  const match = url.match(/\/issues\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}
