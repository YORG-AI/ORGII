/**
 * Pure, no-IO transforms for `org2CloudSessionCommentsAtom.ts`: the fetch
 * entry cache (TTL + identity-scoped eviction), comment-list ops
 * (insert/patch/sort), and thread grouping. Unit-tested directly against
 * these exports — nothing here reads or writes React or atom state.
 */
import {
  type CloudCommentResolution,
  type CloudSessionComment,
  isOrg2CommentErrorCode,
} from "./org2CloudCommentsClient";
import type {
  CloudSessionCommentsEntry,
  CommentThread,
  GroupedCommentThreads,
  SessionCommentsFetchDecision,
} from "./org2CloudSessionCommentsAtom.types";

const SESSION_COMMENTS_TTL_MS = 30_000;
export const MAX_SESSION_COMMENT_CACHE_ENTRIES = 128;

/**
 * A transient listing failure (network blip, or the session row sitting in
 * a momentary engine retract/re-upsert window) must not pin `state:"error"`
 * for the full TTL: an error entry becomes re-claimable after this window,
 * and a mounted consumer arms one deferred retry to actually re-run it.
 * Consecutive failures widen the window exponentially up to the cap so a
 * degraded backend is not hammered at a flat cadence by every open surface.
 */
export const SESSION_COMMENTS_ERROR_RETRY_MS = 10_000;
export const SESSION_COMMENTS_ERROR_RETRY_MAX_MS = 5 * 60_000;

export function sessionCommentsErrorRetryDelayMs(
  consecutiveFailures: number
): number {
  return Math.min(
    SESSION_COMMENTS_ERROR_RETRY_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    SESSION_COMMENTS_ERROR_RETRY_MAX_MS
  );
}

export const EMPTY_ENTRY: CloudSessionCommentsEntry = {
  comments: [],
  viewerOwnsSession: false,
  state: "idle",
  fetchedAt: 0,
};

export function sessionCommentsEntryForIdentity(
  entry: CloudSessionCommentsEntry | undefined,
  identityKey: string | null
): CloudSessionCommentsEntry | undefined {
  return identityKey && entry?.identityKey === identityKey ? entry : undefined;
}

export function writeSessionCommentsEntry(
  entries: Record<string, CloudSessionCommentsEntry>,
  key: string,
  entry: CloudSessionCommentsEntry
): Record<string, CloudSessionCommentsEntry> {
  const next = { ...entries };
  delete next[key];
  next[key] = entry;
  const keys = Object.keys(next);
  while (keys.length > MAX_SESSION_COMMENT_CACHE_ENTRIES) {
    const oldest = keys.shift();
    if (oldest) delete next[oldest];
  }
  return next;
}

// ---------------------------------------------------------------------------
// Pure list transforms (unit-tested; no IO)
// ---------------------------------------------------------------------------

function compareComments(
  left: CloudSessionComment,
  right: CloudSessionComment
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  // Deterministic tiebreak, mirroring the server's `order by created_at, id`.
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Insert (or replace by id) keeping the server's (createdAt, id) order. */
export function insertComment(
  comments: readonly CloudSessionComment[],
  comment: CloudSessionComment
): CloudSessionComment[] {
  const next = comments.filter((existing) => existing.id !== comment.id);
  next.push(comment);
  next.sort(compareComments);
  return next;
}

/** Shallow-patch one comment by id (no-op when the id is unknown). */
export function patchComment(
  comments: readonly CloudSessionComment[],
  commentId: string,
  patch: Partial<CloudSessionComment>
): CloudSessionComment[] {
  return comments.map((comment) =>
    comment.id === commentId ? { ...comment, ...patch } : comment
  );
}

/**
 * The atomic-claim decision, extracted pure so the force-vs-in-flight race
 * is testable: a FORCED refresh that lands while a fetch is in flight must
 * never be silently dropped — its intent is queued and replayed once the running fetch
 * settles. Non-forced calls behind an in-flight fetch or a fresh TTL stay
 * plain skips.
 */
export function decideSessionCommentsFetch(
  entry: CloudSessionCommentsEntry | undefined,
  force: boolean,
  now: number
): SessionCommentsFetchDecision {
  if (entry?.state === "loading") return force ? "queue_force" : "skip";
  const freshnessWindowMs =
    entry?.state === "error"
      ? sessionCommentsErrorRetryDelayMs(entry.consecutiveFailures ?? 1)
      : SESSION_COMMENTS_TTL_MS;
  const fresh =
    entry !== undefined &&
    entry.state !== "idle" &&
    now - entry.fetchedAt <= freshnessWindowMs;
  if (fresh && !force) return "skip";
  return "claim";
}

/**
 * Errors meaning the viewer may no longer SEE this session's comments at
 * all (visibility flip to 'restricted', revoked grant, deleted session).
 * The cached entry must then be EVICTED, not merely flagged 'error': the
 * atom is app-lifetime, and keeping thread bodies readable after the
 * server said FORBIDDEN would defeat the 0002 visibility mirror for
 * already-cached data. Transient failures (network, auth refresh) keep
 * the cache — going blank on a blip would be worse than stale.
 */
export function shouldEvictSessionCommentsOnError(error: unknown): boolean {
  return (
    isOrg2CommentErrorCode(error, "ORG2_FORBIDDEN") ||
    isOrg2CommentErrorCode(error, "ORG2_SESSION_NOT_FOUND")
  );
}

// ---------------------------------------------------------------------------
// Thread grouping (pure; unit-tested)
// ---------------------------------------------------------------------------

function isLiveComment(comment: CloudSessionComment): boolean {
  return !comment.deletedAt;
}

/**
 * Group a session's flat comment list into render-ready threads.
 *
 * - Tombstoned members stay IN their thread (rendered as "comment deleted")
 *   so reply chains keep their anchor; a thread whose every member is a
 *   tombstone is dropped entirely (nothing left to show).
 * - Replies whose parent is missing from the list are dropped defensively
 *   (the server's flat-thread + cascade invariants make this unreachable,
 *   but a stale cache must not crash the transcript).
 * - `presentEventIds === null` means "presence unknown" — anchored threads
 *   then classify as present (`byEventId`), never as orphans.
 */
export function groupCommentThreads(
  comments: readonly CloudSessionComment[],
  presentEventIds: ReadonlySet<string> | null
): GroupedCommentThreads {
  const ordered = [...comments].sort(compareComments);

  const threadsById = new Map<string, CommentThread>();
  const topLevels: CommentThread[] = [];
  for (const comment of ordered) {
    if (comment.parentId) continue;
    const thread: CommentThread = { top: comment, replies: [] };
    threadsById.set(comment.id, thread);
    topLevels.push(thread);
  }
  for (const comment of ordered) {
    if (!comment.parentId) continue;
    threadsById.get(comment.parentId)?.replies.push(comment);
  }

  const byEventId = new Map<string, CommentThread[]>();
  const sessionLevel: CommentThread[] = [];
  const orphaned: CommentThread[] = [];
  for (const thread of topLevels) {
    const hasLiveMember =
      isLiveComment(thread.top) || thread.replies.some(isLiveComment);
    if (!hasLiveMember) continue;

    const anchor = thread.top.eventId;
    if (!anchor) {
      sessionLevel.push(thread);
    } else if (presentEventIds === null || presentEventIds.has(anchor)) {
      const bucket = byEventId.get(anchor);
      if (bucket) {
        bucket.push(thread);
      } else {
        byEventId.set(anchor, [thread]);
      }
    } else {
      orphaned.push(thread);
    }
  }

  return { byEventId, sessionLevel, orphaned };
}

/**
 * Union of the per-provider replay-stream id sets registered for ONE
 * session (`sessionCommentPresentEventIdsAtom` is keyed session → provider
 * instance → id set, so two panes showing the SAME session never clobber
 * each other's entry and closing one pane cannot blank the other's orphan
 * bucket). `null` = no provider currently publishes — presence UNKNOWN,
 * and `groupCommentThreads` then never classifies orphans.
 */
export function mergePresentEventIdEntries(
  entries: Record<string, ReadonlySet<string>> | undefined
): ReadonlySet<string> | null {
  if (!entries) return null;
  const sets = Object.values(entries);
  if (sets.length === 0) return null;
  if (sets.length === 1) return sets[0];
  const merged = new Set<string>();
  for (const set of sets) {
    for (const id of set) merged.add(id);
  }
  return merged;
}

/** Resolve state lives on the thread head (design: thread-level state). */
export function isThreadResolved(thread: CommentThread): boolean {
  return Boolean(thread.top.resolvedAt);
}

export function getThreadResolution(
  thread: CommentThread
): CloudCommentResolution | null {
  if (!thread.top.resolvedAt) return null;
  return thread.top.resolution ?? "resolved";
}

/** Live (non-tombstone) comments across the given threads — badge counts. */
export function countLiveComments(threads: readonly CommentThread[]): number {
  let count = 0;
  for (const thread of threads) {
    if (isLiveComment(thread.top)) count++;
    for (const reply of thread.replies) {
      if (isLiveComment(reply)) count++;
    }
  }
  return count;
}
