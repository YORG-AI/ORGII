/**
 * Per-(orgId, sessionId) session-comment threads (in-memory only).
 *
 * Maps `orgId|sessionId` → the session's `cloud_list_session_comments`
 * entries plus fetch state. Fetched lazily by `useSessionComments` when a
 * comment surface (replay transcript / header notes) mounts for a cloud
 * target, with a short TTL so toggling a thread panel doesn't refetch on
 * every render; `refresh()` bypasses the TTL. Mutations write through the
 * 0014 RPCs and patch the entry in place — the add RPC returns the created
 * row in listing shape, so the insert needs no refetch (design §4
 * "optimistic insert on add"). NOT persisted — visibility is server-side
 * (readable guard + retention window) and rows go stale.
 *
 * 0002: the same fetch also carries the session's agent-task rows
 * (`tasks`, comment_task_wire shape). Comments MERGE per fetch (optimistic
 * adds survive an in-flight snapshot); tasks are WHOLESALE-REPLACED — there
 * are no optimistic task writes (create/claim surfaces call `refresh()`
 * instead), so the server snapshot is always the whole truth. Agent report
 * replies returned by the complete RPC are ordinary comments and insert
 * through the existing `insertComment`.
 */
import { atom, useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { createLogger } from "@src/hooks/logger";

import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import {
  isNewerTaskUpdate,
  org2CloudCommentTasksAtom,
  tasksForSession,
} from "./org2CloudCommentTasksAtom";
import type { CloudCommentTask } from "./org2CloudCommentTasksClient";
import {
  broadcastCommentsChanged,
  org2CloudCommentsSignalAtom,
  orgCommentsKey,
  sessionCommentsKey,
} from "./org2CloudCommentsBus";
import {
  type CloudCommentResolution,
  type CloudSessionComment,
  addSessionComment,
  deleteSessionComment,
  editSessionComment,
  isOrg2CommentErrorCode,
  listSessionComments,
  resolveSessionComment,
} from "./org2CloudCommentsClient";

const log = createLogger("Org2CloudSessionComments");

const SESSION_COMMENTS_TTL_MS = 30_000;

export type CloudSessionCommentsFetchState =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface CloudSessionCommentsEntry {
  comments: CloudSessionComment[];
  /**
   * This session's agent tasks (0002 embed; [] on pre-0002 backends).
   * Wholesale-replaced on every completed fetch — never optimistically
   * patched. Structurally lease-token-free (invariant 1): safe for render.
   */
  tasks: CloudCommentTask[];
  state: CloudSessionCommentsFetchState;
  /** Epoch ms of the last completed fetch attempt (0 ⇒ never fetched). */
  fetchedAt: number;
}

const EMPTY_ENTRY: CloudSessionCommentsEntry = {
  comments: [],
  tasks: [],
  state: "idle",
  fetchedAt: 0,
};

export const org2CloudSessionCommentsAtom = atom<
  Record<string, CloudSessionCommentsEntry>
>({});
org2CloudSessionCommentsAtom.debugLabel = "org2CloudSessionCommentsAtom";

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
 * The thread head's task, if the thread was promoted (UNIQUE `comment_id`
 * server-side ⇒ at most one — reruns go through reopen, never a second
 * task). Undefined for never-promoted threads and on pre-0002 backends.
 */
export function findTaskForThread(
  tasks: readonly CloudCommentTask[],
  commentId: string
): CloudCommentTask | undefined {
  return tasks.find((task) => task.commentId === commentId);
}

export type SessionCommentsFetchDecision = "claim" | "skip" | "queue_force";

/**
 * The atomic-claim decision, extracted pure so the force-vs-in-flight race
 * is testable: a FORCED refresh that lands while a fetch is in flight must
 * never be silently dropped — its intent (a terminal task write just
 * changed the server row) is queued and replayed once the running fetch
 * settles. Non-forced calls behind an in-flight fetch or a fresh TTL stay
 * plain skips.
 */
export function decideSessionCommentsFetch(
  entry: CloudSessionCommentsEntry | undefined,
  force: boolean,
  now: number
): SessionCommentsFetchDecision {
  if (entry?.state === "loading") return force ? "queue_force" : "skip";
  const fresh =
    entry !== undefined &&
    entry.state !== "idle" &&
    now - entry.fetchedAt <= SESSION_COMMENTS_TTL_MS;
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

/**
 * Engine-poll reconciliation probe: signature of the engine's per-org task
 * rows (60s `cloud_list_comment_tasks` pull) that are STRICTLY newer than —
 * or unknown to — the per-session comments/tasks embed. `null` = the embed
 * is current. A non-null signature triggers ONE forced embed refetch (the
 * embed stays the single render source; the engine atom is only an
 * invalidation signal), and the caller latches the signature so a server
 * that keeps the row out of the embed (visibility skew) can never loop the
 * fetch. Engine rows MISSING from the embed's id set are counted (new task
 * created elsewhere); embed rows missing from the engine map are not — the
 * engine map lingers cascade-deleted rows until its full-listing rebuild.
 */
export function findNewerEngineTaskSignature(
  embedTasks: readonly CloudCommentTask[],
  engineTasks: readonly CloudCommentTask[]
): string | null {
  if (engineTasks.length === 0) return null;
  const embedById = new Map(embedTasks.map((task) => [task.id, task]));
  const newer = engineTasks.filter((task) => {
    const known = embedById.get(task.id);
    return (
      known === undefined || isNewerTaskUpdate(task.updatedAt, known.updatedAt)
    );
  });
  if (newer.length === 0) return null;
  return newer
    .map((task) => `${task.id}:${task.updatedAt}`)
    .sort()
    .join("|");
}

// ---------------------------------------------------------------------------
// Thread grouping (pure; unit-tested)
// ---------------------------------------------------------------------------

export interface CommentThread {
  top: CloudSessionComment;
  /** Direct replies, (createdAt, id) asc. Flat: replies never nest. */
  replies: CloudSessionComment[];
}

export interface GroupedCommentThreads {
  /** Threads anchored to a PRESENT event id, keyed by that id. */
  byEventId: Map<string, CommentThread[]>;
  /** Unanchored session-level notes. */
  sessionLevel: CommentThread[];
  /**
   * Threads whose anchor event no longer exists in the local replay stream
   * (owner-side epoch rewrite dropped it). Rendered in an "earlier version"
   * bucket — never crash, never silently vanish.
   */
  orphaned: CommentThread[];
}

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

// ---------------------------------------------------------------------------
// Shared auth composition
// ---------------------------------------------------------------------------

/**
 * The `ensureFreshSession` + `commitRefreshedAuth` composition as ONE
 * stable callback: a fresh JWT per RPC batch, committed compare-and-set so
 * a signed-out auth atom is never resurrected. This is the blessed
 * React-side variant of the idiom, shared by `useSessionComments` and the
 * task surfaces (`SessionCommentsContext`'s create/reopen/reset wrappers);
 * the headless runner carries its own store-backed copy inside
 * `buildDefaultCommentTaskRunnerDeps`. Reads auth through a ref so the
 * token-refresh write inside a batch never retriggers the callers' effects
 * (org2CloudRemoteSessionsAtom idiom).
 */
export function useCloudFreshAccessToken(): () => Promise<string> {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  return useCallback(async (): Promise<string> => {
    const current = authRef.current;
    if (!current) throw new Error("not signed in to ORG2 Cloud");
    const fresh = await ensureFreshSession(current);
    if (!fresh) throw new Error("token refresh failed");
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth]);
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface AddCommentInput {
  body: string;
  eventId?: string;
  parentId?: string;
}

export interface UseSessionCommentsResult {
  comments: CloudSessionComment[];
  /** This session's agent tasks (0002; [] on pre-0002 backends). */
  tasks: CloudCommentTask[];
  state: CloudSessionCommentsFetchState;
  /** Refetch now, ignoring the TTL. */
  refresh: () => void;
  /**
   * The thread head's task (UNIQUE comment_id ⇒ at most one), or undefined
   * for never-promoted threads. Read-side selector only — task mutations go
   * through the tasks client, then `refresh()`.
   */
  taskForThread: (commentId: string) => CloudCommentTask | undefined;
  /**
   * Local-only insert of a server-shaped comment row — the complete RPC
   * returns its `agent_report` reply byte-identical to a list entry
   * (add/list parity rule), so the runner bridge inserts it without a
   * refetch. No RPC fires; the next TTL refetch reconciles regardless.
   */
  insertLocalComment: (comment: CloudSessionComment) => void;
  /** Resolves with the created comment (already inserted); rejects on
   *  failure so composers can keep the draft (design §4 non-goals). */
  addComment: (input: AddCommentInput) => Promise<CloudSessionComment>;
  editComment: (commentId: string, body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  resolveComment: (
    commentId: string,
    resolved: boolean,
    resolution?: CloudCommentResolution
  ) => Promise<void>;
}

/**
 * Comments for `(orgId, sessionId)` (either null ⇒ no cloud comment target —
 * returns the idle empty entry, fetches nothing, mutations reject).
 * Auto-fetches when the entry is missing or older than the TTL. Multiple
 * mounted instances (turn chrome + header notes) share the atom entry; the
 * fetch CLAIM happens inside one atom updater (decide-and-mark against live
 * store state), so two instances mounting in the same commit cannot both
 * fire the list RPC — a render-snapshot guard would.
 */
/**
 * Keys whose in-flight fetch swallowed a FORCED refresh: replayed with one
 * more forced fetch the moment the running fetch settles (module-level —
 * the atom entry is shared across hook instances, so the queue must be
 * too). A Set, so N dropped forces replay as ONE refetch.
 */
const pendingForceRefetchKeys = new Set<string>();

export function useSessionComments(
  orgId: string | null,
  sessionId: string | null
): UseSessionCommentsResult {
  const auth = useAtomValue(org2CloudAuthAtom);
  const [entries, setEntries] = useAtom(org2CloudSessionCommentsAtom);
  const signedIn = Boolean(auth);
  const key = orgId && sessionId ? sessionCommentsKey(orgId, sessionId) : null;

  const withFreshToken = useCloudFreshAccessToken();

  const fetchComments = useCallback(
    async (
      targetOrgId: string,
      targetSessionId: string,
      options?: { force?: boolean }
    ): Promise<void> => {
      const targetKey = sessionCommentsKey(targetOrgId, targetSessionId);
      let force = Boolean(options?.force);
      for (;;) {
        // Atomic claim: decide-and-mark in ONE updater against live store
        // state. Two hook instances mounting in the same commit both call in
        // here, but only the first updater run sees a non-loading entry.
        // Snapshot the ids known at claim time so the post-fetch merge can
        // tell an optimistic insert (added DURING the fetch — absent here)
        // from a row the server dropped (present here, missing from the
        // response) and must therefore evict.
        let claimed = false;
        let queuedForce = false;
        let knownIdsAtStart = new Set<string>();
        setEntries((previous) => {
          const entry = previous[targetKey];
          const decision = decideSessionCommentsFetch(entry, force, Date.now());
          if (decision !== "claim") {
            // A force behind an in-flight fetch is QUEUED, never dropped:
            // the running fetch's snapshot may predate the write this force
            // is meant to surface (terminal task states would stay stale
            // forever otherwise — nothing else refetches the embed).
            queuedForce = decision === "queue_force";
            return previous;
          }
          claimed = true;
          knownIdsAtStart = new Set(
            (entry?.comments ?? []).map((comment) => comment.id)
          );
          return {
            ...previous,
            [targetKey]: {
              ...(entry ?? EMPTY_ENTRY),
              state: "loading",
            },
          };
        });
        if (!claimed) {
          if (queuedForce) pendingForceRefetchKeys.add(targetKey);
          return;
        }
        try {
          const accessToken = await withFreshToken();
          const { comments, tasks } = await listSessionComments(
            accessToken,
            targetOrgId,
            targetSessionId
          );
          // MERGE, not wholesale-replace: preserve ONLY rows that appeared
          // locally AFTER the fetch was claimed (optimistic adds the server
          // snapshot predates — their id is not in knownIdsAtStart). A row
          // that WAS known at start but is missing from the response was
          // deleted server-side (e.g. GDPR erasure) and is dropped — merging
          // it back would make it immortal.
          // Tasks, by contrast, ARE wholesale-replaced: nothing writes them
          // optimistically (design §4), so the fetched embed is the whole
          // truth and merging could only resurrect stale rows.
          setEntries((previous) => {
            const existing = previous[targetKey]?.comments ?? [];
            const fetchedIds = new Set(comments.map((comment) => comment.id));
            const merged = existing
              .filter(
                (comment) =>
                  !fetchedIds.has(comment.id) &&
                  !knownIdsAtStart.has(comment.id)
              )
              .reduce(
                (list, comment) => insertComment(list, comment),
                comments
              );
            return {
              ...previous,
              [targetKey]: {
                comments: merged,
                tasks,
                state: "ready",
                fetchedAt: Date.now(),
              },
            };
          });
        } catch (error) {
          log.warn("cloud_list_session_comments failed:", error);
          // Visibility revocation EVICTS the cached bodies (0002 invariant
          // 5 for already-cached data); transient failures keep them.
          const evict = shouldEvictSessionCommentsOnError(error);
          setEntries((previous) => ({
            ...previous,
            [targetKey]: {
              ...(evict ? EMPTY_ENTRY : (previous[targetKey] ?? EMPTY_ENTRY)),
              state: "error",
              fetchedAt: Date.now(),
            },
          }));
        }
        // A force that arrived while THIS fetch was in flight replays as
        // exactly one more forced round-trip (the Set collapses N drops).
        if (!pendingForceRefetchKeys.delete(targetKey)) return;
        force = true;
      }
    },
    [setEntries, withFreshToken]
  );

  useEffect(() => {
    if (!orgId || !sessionId || !signedIn) return;
    // TTL + in-flight dedup live inside fetchComments' atomic claim.
    void fetchComments(orgId, sessionId);
  }, [orgId, sessionId, signedIn, fetchComments]);

  // --- Engine-poll reconciliation (the ONLY recurring pull, CPU rule) -----
  // The sync engine's 60s pass merges `cloud_list_comment_tasks` into
  // org2CloudCommentTasksAtom; nothing else refetches this atom's embed
  // while a session stays open. When the engine reports a row for THIS
  // session that the embed doesn't know (or knows older), force ONE
  // TTL-bypassing refetch so card state, turn badges, resolve nudges AND
  // report replies converge — no second timer is ever added, and the
  // signature latch bounds it to one refetch per distinct engine snapshot.
  const entry = (key ? entries[key] : undefined) ?? EMPTY_ENTRY;
  const engineTasksByOrg = useAtomValue(org2CloudCommentTasksAtom);
  const engineTasks = useMemo(
    () =>
      orgId && sessionId
        ? tasksForSession(engineTasksByOrg, orgId, sessionId)
        : [],
    [engineTasksByOrg, orgId, sessionId]
  );
  const staleSignature = useMemo(
    () => findNewerEngineTaskSignature(entry.tasks, engineTasks),
    [entry.tasks, engineTasks]
  );
  const entryState = entry.state;
  const forcedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!orgId || !sessionId || !signedIn || staleSignature === null) return;
    // idle/loading: the mount fetch (or the in-flight one) is about to
    // deliver an embed at least as fresh as the engine snapshot.
    if (entryState !== "ready" && entryState !== "error") return;
    if (forcedSignatureRef.current === staleSignature) return;
    forcedSignatureRef.current = staleSignature;
    void fetchComments(orgId, sessionId, { force: true });
  }, [orgId, sessionId, signedIn, staleSignature, entryState, fetchComments]);

  const refresh = useCallback(() => {
    if (!orgId || !sessionId || !signedIn) return;
    void fetchComments(orgId, sessionId, { force: true });
  }, [orgId, sessionId, signedIn, fetchComments]);

  // --- Realtime nudge (comments bus): a peer's comment/task mutation
  // broadcast bumps this counter — force-refetch immediately so the open
  // thread streams. Event-driven only; no timer.
  const commentsSignal = useAtomValue(org2CloudCommentsSignalAtom);
  const signalVersion =
    orgId && sessionId
      ? (commentsSignal[sessionCommentsKey(orgId, sessionId)] ?? 0)
      : 0;
  const orgSignalVersion = orgId
    ? (commentsSignal[orgCommentsKey(orgId)] ?? 0)
    : 0;
  const lastSignalRef = useRef({ session: 0, org: 0 });
  useEffect(() => {
    if (!orgId || !sessionId || !signedIn) return;
    if (
      signalVersion === lastSignalRef.current.session &&
      orgSignalVersion === lastSignalRef.current.org
    ) {
      return;
    }
    lastSignalRef.current = {
      session: signalVersion,
      org: orgSignalVersion,
    };
    if (signalVersion === 0 && orgSignalVersion === 0) return;
    void fetchComments(orgId, sessionId, { force: true });
  }, [
    orgId,
    sessionId,
    signedIn,
    signalVersion,
    orgSignalVersion,
    fetchComments,
  ]);

  /** Apply a pure comments transform to the current entry. */
  const patchEntry = useCallback(
    (
      targetKey: string,
      transform: (comments: CloudSessionComment[]) => CloudSessionComment[]
    ) => {
      setEntries((previous) => {
        const entry = previous[targetKey] ?? EMPTY_ENTRY;
        return {
          ...previous,
          [targetKey]: { ...entry, comments: transform(entry.comments) },
        };
      });
    },
    [setEntries]
  );

  const insertLocalComment = useCallback(
    (comment: CloudSessionComment): void => {
      if (!key) return;
      patchEntry(key, (comments) => insertComment(comments, comment));
    },
    [key, patchEntry]
  );

  const addComment = useCallback(
    async (input: AddCommentInput): Promise<CloudSessionComment> => {
      if (!orgId || !sessionId || !key) {
        throw new Error("no cloud comment target");
      }
      const accessToken = await withFreshToken();
      const comment = await addSessionComment(accessToken, {
        orgId,
        sessionId,
        body: input.body,
        eventId: input.eventId,
        parentId: input.parentId,
      });
      // The RPC returns the row in listing shape — insert without a refetch.
      patchEntry(key, (comments) => insertComment(comments, comment));
      broadcastCommentsChanged(orgId, sessionId);
      return comment;
    },
    [orgId, sessionId, key, withFreshToken, patchEntry]
  );

  const editComment = useCallback(
    async (commentId: string, body: string): Promise<void> => {
      if (!orgId || !key) throw new Error("no cloud comment target");
      const accessToken = await withFreshToken();
      const editedAt = await editSessionComment(
        accessToken,
        orgId,
        commentId,
        body
      );
      patchEntry(key, (comments) =>
        patchComment(comments, commentId, { body, editedAt })
      );
      if (sessionId) broadcastCommentsChanged(orgId, sessionId);
    },
    [orgId, sessionId, key, withFreshToken, patchEntry]
  );

  const deleteComment = useCallback(
    async (commentId: string): Promise<void> => {
      if (!orgId || !key) throw new Error("no cloud comment target");
      const accessToken = await withFreshToken();
      await deleteSessionComment(accessToken, orgId, commentId);
      // Mirror the server's soft delete: stamp + blank body (tombstone).
      patchEntry(key, (comments) =>
        patchComment(comments, commentId, {
          deletedAt: new Date().toISOString(),
          body: "",
        })
      );
      if (sessionId) broadcastCommentsChanged(orgId, sessionId);
    },
    [orgId, sessionId, key, withFreshToken, patchEntry]
  );

  const resolveComment = useCallback(
    async (
      commentId: string,
      resolved: boolean,
      resolution?: CloudCommentResolution
    ): Promise<void> => {
      if (!orgId || !key) throw new Error("no cloud comment target");
      const accessToken = await withFreshToken();
      await resolveSessionComment(
        accessToken,
        orgId,
        commentId,
        resolved,
        resolution
      );
      patchEntry(key, (comments) =>
        patchComment(comments, commentId, {
          resolvedAt: resolved ? new Date().toISOString() : undefined,
          resolution: resolved ? (resolution ?? "resolved") : undefined,
        })
      );
      if (sessionId) broadcastCommentsChanged(orgId, sessionId);
    },
    [orgId, sessionId, key, withFreshToken, patchEntry]
  );

  const entryTasks = entry.tasks;
  const taskForThread = useCallback(
    (commentId: string): CloudCommentTask | undefined =>
      findTaskForThread(entryTasks, commentId),
    [entryTasks]
  );
  return {
    comments: entry.comments,
    tasks: entry.tasks,
    state: entry.state,
    refresh,
    taskForThread,
    insertLocalComment,
    addComment,
    editComment,
    deleteComment,
    resolveComment,
  };
}
