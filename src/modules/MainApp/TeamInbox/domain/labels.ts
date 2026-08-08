import { WORK_ITEM_STATUS } from "@src/types/core/workItem";

/** GitHub-backed Work Items use the open/closed status vocabulary. */
export function isGitHubIssueStatus(status: string): boolean {
  return (
    status === WORK_ITEM_STATUS.GITHUB_OPEN ||
    status === WORK_ITEM_STATUS.GITHUB_CLOSED
  );
}

/** Resolve a displayable GitHub issue number from `61` or `#61`. */
export function parseGitHubIssueNumber(
  value: string | null | undefined
): number | undefined {
  const match = value?.trim().match(/^#?(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Turns a raw enum token from the work-item read model (e.g. `in_progress`,
 * `HIGH`, `in-review`) into a human sentence-cased label (`In progress`,
 * `High`, `In review`).
 *
 * This is the deterministic fallback for values that have no explicit localized
 * key; callers pass the result as the i18next `defaultValue` so a translated
 * label wins when present and raw enum strings never leak to the UI.
 */
export function humanizeToken(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * i18n key for a work-item status/priority token, with a humanized default.
 *
 * Team Inbox deliberately owns the `teamInbox.workItemStatus.*` /
 * `teamInbox.priority.*` namespaces instead of reusing ProjectManager's
 * `workItems.statusLabels.*` / `workItems.priorityLabels.*`. The two label sets
 * model *different* status vocabularies — Team Inbox surfaces read-model tokens
 * like `todo` / `done` / `blocked`, while ProjectManager uses `planned` /
 * `completed` and omits `blocked` — so pointing at the shared keys would drop
 * those labels to the humanized fallback. Keeping the namespaces separate is
 * intentional isolation, not accidental duplication; the humanized default keeps
 * any unmapped token readable.
 */
export function workItemStatusLabelKey(status: string): string {
  return `teamInbox.workItemStatus.${status}`;
}

/** i18n key for a work-item priority token, with a humanized default value. */
export function workItemPriorityLabelKey(priority: string): string {
  return `teamInbox.priority.${priority}`;
}
