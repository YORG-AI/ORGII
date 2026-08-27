import type {
  TeamInboxFilter,
  TeamInboxIssue,
  TeamInboxItem,
  TeamInboxNavigationIntent,
  TeamInboxPage,
} from "./types";

const INVALID_TIMESTAMP = Number.NEGATIVE_INFINITY;
const TERMINAL_ASSIGNED_WORK_ITEM_STATUSES = new Set([
  "completed",
  "cancelled",
  "canceled",
  "duplicate",
  "closed",
  "done",
]);

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? INVALID_TIMESTAMP : parsed;
}

export function getTeamInboxItemKey(item: TeamInboxItem): string {
  return `${item.kind}:${item.id}`;
}

/**
 * Team Inbox is an actionable surface rather than a Work Item history view.
 * Assignment rows stop being actionable as soon as their current status is
 * terminal; comment mentions remain visible until the user handles them.
 */
export function isActionableTeamInboxItem(item: TeamInboxItem): boolean {
  if (item.kind !== "assigned_work_item") return true;
  const status = item.payload.status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return !TERMINAL_ASSIGNED_WORK_ITEM_STATUSES.has(status);
}

/**
 * De-duplicates pages by canonical item identity. When a later page contains a
 * fresher copy of the same item, the fresher copy wins.
 */
export function dedupeTeamInboxItems(
  items: readonly TeamInboxItem[]
): TeamInboxItem[] {
  const byKey = new Map<string, TeamInboxItem>();

  for (const item of items) {
    const key = getTeamInboxItemKey(item);
    const current = byKey.get(key);
    if (
      !current ||
      timestamp(item.occurredAt) > timestamp(current.occurredAt)
    ) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()];
}

/** Newest first; identity is a deterministic tie-breaker for cursor stability. */
export function sortTeamInboxItems(
  items: readonly TeamInboxItem[]
): TeamInboxItem[] {
  return [...items].sort((left, right) => {
    const timeDifference =
      timestamp(right.occurredAt) - timestamp(left.occurredAt);
    if (timeDifference !== 0) return timeDifference;
    return getTeamInboxItemKey(left).localeCompare(getTeamInboxItemKey(right));
  });
}

export function filterTeamInboxItems(
  items: readonly TeamInboxItem[],
  filter: TeamInboxFilter
): TeamInboxItem[] {
  const actionableItems = items.filter(isActionableTeamInboxItem);
  if (filter === "all") return actionableItems;
  const kind = filter === "mentions" ? "comment_mention" : "assigned_work_item";
  return actionableItems.filter((item) => item.kind === kind);
}

export function selectTeamInboxItems(
  items: readonly TeamInboxItem[],
  filter: TeamInboxFilter
): TeamInboxItem[] {
  return filterTeamInboxItems(
    sortTeamInboxItems(dedupeTeamInboxItems(items)),
    filter
  );
}

/** Fields searched for each item kind, so the free-text query stays discoverable. */
function searchableText(item: TeamInboxItem): string[] {
  if (item.kind === "comment_mention") {
    return [
      item.target.kind === "session_comment"
        ? item.target.sessionTitle
        : item.target.workItemTitle,
      item.payload.commentBody,
      item.payload.context ?? "",
      item.actor.displayName,
    ];
  }
  return [
    item.payload.title,
    item.payload.summary ?? "",
    item.payload.assigneeName ?? item.payload.assigneeMemberId,
    item.payload.status,
    item.payload.priority,
    item.actor.displayName,
  ];
}

/**
 * Case-insensitive free-text filter over the already-loaded items. An empty or
 * whitespace-only query returns every item unchanged; otherwise an item is kept
 * when any of its searchable fields contains the query.
 */
export function searchTeamInboxItems(
  items: readonly TeamInboxItem[],
  query: string
): TeamInboxItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    searchableText(item).some((text) => text.toLowerCase().includes(needle))
  );
}

export function countUnreadTeamInboxItems(
  items: readonly TeamInboxItem[]
): number {
  return dedupeTeamInboxItems(items)
    .filter(isActionableTeamInboxItem)
    .reduce((count, item) => count + (item.readAt === null ? 1 : 0), 0);
}

export interface TeamInboxUnreadCounts {
  all: number;
  mentions: number;
  assigned: number;
}

/**
 * Unread totals split by the surfaces the filter tabs expose. Canonical items
 * are de-duplicated first so a duplicated page never double-counts a badge.
 */
export function countUnreadTeamInboxItemsByFilter(
  items: readonly TeamInboxItem[]
): TeamInboxUnreadCounts {
  return dedupeTeamInboxItems(items)
    .filter(isActionableTeamInboxItem)
    .reduce<TeamInboxUnreadCounts>(
      (counts, item) => {
        if (item.readAt !== null) return counts;
        counts.all += 1;
        if (item.kind === "comment_mention") counts.mentions += 1;
        else counts.assigned += 1;
        return counts;
      },
      { all: 0, mentions: 0, assigned: 0 }
    );
}

/** Maps a filter tab to the item kind it exposes, or null for the combined view. */
export function filterItemKind(
  filter: TeamInboxFilter
): TeamInboxItem["kind"] | null {
  if (filter === "mentions") return "comment_mention";
  if (filter === "assigned") return "assigned_work_item";
  return null;
}

export function toTeamInboxNavigationIntent(
  item: TeamInboxItem
): TeamInboxNavigationIntent {
  if (item.target.kind === "session_comment") {
    return {
      kind: "open_session_comment",
      sessionId: item.target.sessionId,
      commentId: item.target.commentId,
      threadId: item.target.threadId,
      ...(item.target.anchor ? { anchor: item.target.anchor } : {}),
    };
  }

  return {
    kind: "open_work_item",
    orgId: item.target.orgId,
    projectId: item.target.projectId,
    workItemId: item.target.workItemId,
  };
}

export interface LoadState {
  status: "loading" | "ready" | "warning" | "error";
  message: string | null;
}

export function loadStateForPage(
  page: TeamInboxPage,
  issueMessage: (issue: TeamInboxIssue) => string
): LoadState {
  if (page.issue) {
    return {
      status: page.issue.code === "partial_load" ? "warning" : "error",
      message: issueMessage(page.issue),
    };
  }
  // A retained snapshot remains usable while it revalidates. Only an empty
  // scope needs a blocking loading state.
  return page.loading && page.items.length === 0
    ? { status: "loading", message: null }
    : { status: "ready", message: null };
}
