import {
  type SessionDateBucket,
  getSessionDateBucketRanges,
} from "@src/util/session/sessionDateBuckets";

import type {
  TeamInboxFilter,
  TeamInboxItem,
  TeamInboxNavigationIntent,
} from "./types";

const INVALID_TIMESTAMP = Number.NEGATIVE_INFINITY;

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? INVALID_TIMESTAMP : parsed;
}

export function getTeamInboxItemKey(item: TeamInboxItem): string {
  return `${item.kind}:${item.id}`;
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
  if (filter === "all") return [...items];
  const kind = filter === "mentions" ? "comment_mention" : "assigned_work_item";
  return items.filter((item) => item.kind === kind);
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
      item.target.sessionTitle,
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

export type TeamInboxRecencyGroupKey =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "earlier";

export interface TeamInboxRecencyGroup {
  key: TeamInboxRecencyGroupKey;
  items: TeamInboxItem[];
}

const RECENCY_GROUP_ORDER: TeamInboxRecencyGroupKey[] = [
  "today",
  "yesterday",
  "thisWeek",
  "earlier",
];

/**
 * Maps the shared session date-bucket keys onto the Team Inbox recency keys, so
 * both surfaces derive day boundaries from one source of truth
 * (`getSessionDateBucketRanges`). Only the presentation key name differs
 * ("earlier" here vs "older" in the shared helper).
 */
const SESSION_BUCKET_TO_RECENCY: Record<
  SessionDateBucket,
  TeamInboxRecencyGroupKey
> = {
  today: "today",
  yesterday: "yesterday",
  thisWeek: "thisWeek",
  older: "earlier",
};

/**
 * Buckets already-ordered items into recency sections relative to `nowMs`
 * (Today / Yesterday / This week / Earlier). Day boundaries are reused from the
 * shared `getSessionDateBucketRanges` helper so the "this week" window stays
 * consistent with the rest of the app. Empty groups are omitted and group order
 * is stable; unparseable timestamps fall into "earlier".
 */
export function groupTeamInboxItemsByRecency(
  items: readonly TeamInboxItem[],
  nowMs: number
): TeamInboxRecencyGroup[] {
  const ranges = getSessionDateBucketRanges(new Date(nowMs));

  const buckets: Record<TeamInboxRecencyGroupKey, TeamInboxItem[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };

  for (const item of items) {
    const occurred = Date.parse(item.occurredAt);
    let key: TeamInboxRecencyGroupKey = "earlier";
    if (!Number.isNaN(occurred)) {
      const match = ranges.find(
        ({ startMs, endMs }) =>
          (startMs === undefined || occurred >= startMs) &&
          (endMs === undefined || occurred < endMs)
      );
      if (match) key = SESSION_BUCKET_TO_RECENCY[match.bucket];
    }
    buckets[key].push(item);
  }

  return RECENCY_GROUP_ORDER.filter((key) => buckets[key].length > 0).map(
    (key) => ({ key, items: buckets[key] })
  );
}

export function countUnreadTeamInboxItems(
  items: readonly TeamInboxItem[]
): number {
  return dedupeTeamInboxItems(items).reduce(
    (count, item) => count + (item.readAt === null ? 1 : 0),
    0
  );
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
  return dedupeTeamInboxItems(items).reduce<TeamInboxUnreadCounts>(
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
    projectId: item.target.projectId,
    workItemId: item.target.workItemId,
  };
}
