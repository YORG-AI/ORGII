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
 */
import { atom, useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import {
  broadcastCommentsChangedToPeers,
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
  listSessionComments,
  resolveSessionComment,
} from "./org2CloudCommentsClient";
import {
  EMPTY_ENTRY,
  decideSessionCommentsFetch,
  insertComment,
  mergeDeltaSessionComments,
  mergeFullSessionComments,
  patchComment,
  sessionCommentsDeltaSince,
  sessionCommentsEntryForIdentity,
  sessionCommentsErrorRetryDelayMs,
  shouldEvictSessionCommentsOnError,
  writeSessionCommentsEntry,
} from "./org2CloudSessionCommentsAtom.commentTransforms";
import {
  activeForceTokenByKey,
  completedForceTokenByKey,
  dropPendingForce,
  pendingForceRefetchKeys,
  pendingForceTokenByKey,
  rememberCompletedForceToken,
} from "./org2CloudSessionCommentsAtom.forceTokenTracker";
import { useCloudFreshAccessToken } from "./org2CloudSessionCommentsAtom.freshToken";
import type {
  AddCommentInput,
  CloudSessionCommentsEntry,
  UseSessionCommentsResult,
} from "./org2CloudSessionCommentsAtom.types";

// Re-exports: preserve this module's public import path for symbols that
// now live in the sibling modules above (types / pure transforms /
// shared auth composition) — every existing importer keeps working
// unchanged.
export type {
  AddCommentInput,
  CloudSessionCommentsEntry,
  CloudSessionCommentsFetchState,
  CommentThread,
  GroupedCommentThreads,
  SessionCommentsFetchDecision,
  UseSessionCommentsResult,
} from "./org2CloudSessionCommentsAtom.types";
export {
  MAX_SESSION_COMMENT_CACHE_ENTRIES,
  SESSION_COMMENTS_DELTA_OVERLAP_MS,
  SESSION_COMMENTS_ERROR_RETRY_MS,
  SESSION_COMMENTS_ERROR_RETRY_MAX_MS,
  sessionCommentsDeltaSince,
  sessionCommentsErrorRetryDelayMs,
  countLiveComments,
  decideSessionCommentsFetch,
  getThreadResolution,
  groupCommentThreads,
  insertComment,
  isThreadResolved,
  mergeDeltaSessionComments,
  mergeFullSessionComments,
  mergePresentEventIdEntries,
  patchComment,
  sessionCommentsEntryForIdentity,
  shouldEvictSessionCommentsOnError,
  writeSessionCommentsEntry,
} from "./org2CloudSessionCommentsAtom.commentTransforms";
export { useCloudFreshAccessToken } from "./org2CloudSessionCommentsAtom.freshToken";

const log = createLogger("Org2CloudSessionComments");

export const org2CloudSessionCommentsAtom = atom<
  Record<string, CloudSessionCommentsEntry>
>({});
org2CloudSessionCommentsAtom.debugLabel = "org2CloudSessionCommentsAtom";

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Comments for `(orgId, sessionId)` (either null ⇒ no cloud comment target —
 * returns the idle empty entry, fetches nothing, mutations reject).
 * Auto-fetches when the entry is missing or older than the TTL. Multiple
 * mounted instances (turn chrome + header notes) share the atom entry; the
 * fetch CLAIM happens inside one atom updater (decide-and-mark against live
 * store state), so two instances mounting in the same commit cannot both
 * fire the list RPC — a render-snapshot guard would.
 *
 * The force-refetch de-dup state (in-flight claims, signal tokens) lives in
 * `org2CloudSessionCommentsAtom.forceTokenTracker.ts` — module-level because
 * the atom entry above is shared across every mounted hook instance for the
 * same key, so the de-dup state must be too.
 */
export function useSessionComments(
  orgId: string | null,
  sessionId: string | null,
  originSessionId: string | null = null
): UseSessionCommentsResult {
  const auth = useAtomValue(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const [entries, setEntries] = useAtom(org2CloudSessionCommentsAtom);
  const signedIn = Boolean(auth);
  const key = orgId && sessionId ? sessionCommentsKey(orgId, sessionId) : null;

  const withFreshToken = useCloudFreshAccessToken();

  const fetchComments = useCallback(
    async (
      targetOrgId: string,
      targetSessionId: string,
      options?: { force?: boolean; forceToken?: string }
    ): Promise<void> => {
      const targetKey = sessionCommentsKey(targetOrgId, targetSessionId);
      const requestIdentityKey = authIdentityKey;
      if (!requestIdentityKey) return;
      const requestKey = `${requestIdentityKey}\u001f${targetKey}`;
      let force = Boolean(options?.force);
      let forceToken = options?.forceToken;
      if (
        forceToken &&
        (activeForceTokenByKey.get(requestKey) === forceToken ||
          pendingForceTokenByKey.get(requestKey) === forceToken ||
          completedForceTokenByKey.get(requestKey) === forceToken)
      ) {
        return;
      }
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
        let anchorAtStart: string | undefined;
        setEntries((previous) => {
          const stored = previous[targetKey];
          const entry =
            stored?.identityKey === requestIdentityKey ? stored : undefined;
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
          anchorAtStart = entry?.lastServerTime;
          return writeSessionCommentsEntry(previous, targetKey, {
            ...(entry ?? EMPTY_ENTRY),
            identityKey: requestIdentityKey,
            state: "loading",
          });
        });
        if (!claimed) {
          if (queuedForce) {
            if (forceToken) {
              pendingForceTokenByKey.set(requestKey, forceToken);
            } else {
              pendingForceRefetchKeys.add(requestKey);
            }
          }
          return;
        }
        if (forceToken) activeForceTokenByKey.set(requestKey, forceToken);
        try {
          const accessToken = await withFreshToken();
          const currentAuth = authRef.current;
          if (
            !currentAuth ||
            org2CloudAuthIdentityKey(currentAuth) !== requestIdentityKey
          ) {
            dropPendingForce(requestKey);
            return;
          }
          // Force paths (manual refresh, session-signal tokens, the
          // SUBSCRIBED-edge recovery) stay FULL listings — a full snapshot
          // is the only read that reconciles the stamp-free un-resolve.
          // TTL/org-signal refetches pull the delta behind the stored anchor.
          const since =
            !force && anchorAtStart !== undefined
              ? sessionCommentsDeltaSince(anchorAtStart)
              : undefined;
          const listing = await listSessionComments(
            accessToken,
            targetOrgId,
            targetSessionId,
            since !== undefined ? { since } : undefined
          );
          const latestAfterFetch = authRef.current;
          if (
            !latestAfterFetch ||
            org2CloudAuthIdentityKey(latestAfterFetch) !== requestIdentityKey
          ) {
            dropPendingForce(requestKey);
            return;
          }
          // MERGE, not wholesale-replace — see mergeFullSessionComments /
          // mergeDeltaSessionComments for the two paths' invariants. The
          // fallback-aware `appliedSince` (not the requested `since`) picks
          // the path: a pre-delta backend answers every request in full.
          setEntries((previous) => {
            const latestAuth = authRef.current;
            if (
              !latestAuth ||
              org2CloudAuthIdentityKey(latestAuth) !== requestIdentityKey
            ) {
              return previous;
            }
            const stored = previous[targetKey];
            const sameIdentity = stored?.identityKey === requestIdentityKey;
            const existing = sameIdentity ? stored.comments : [];
            const merged =
              listing.appliedSince !== undefined
                ? mergeDeltaSessionComments(existing, listing.comments)
                : mergeFullSessionComments(
                    existing,
                    listing.comments,
                    knownIdsAtStart
                  );
            const lastServerTime =
              listing.serverTime ??
              (sameIdentity ? stored.lastServerTime : undefined);
            return writeSessionCommentsEntry(previous, targetKey, {
              identityKey: requestIdentityKey,
              comments: merged,
              viewerOwnsSession: listing.viewerOwnsSession,
              state: "ready",
              fetchedAt: Date.now(),
              ...(lastServerTime !== undefined ? { lastServerTime } : {}),
            });
          });
        } catch (error) {
          const latestAuth = authRef.current;
          if (
            !latestAuth ||
            org2CloudAuthIdentityKey(latestAuth) !== requestIdentityKey
          ) {
            dropPendingForce(requestKey);
            return;
          }
          log.warn(
            `cloud_list_session_comments failed for ${targetKey}:`,
            error
          );
          // Visibility revocation EVICTS the cached bodies (0002 invariant
          // 5 for already-cached data); transient failures keep them.
          const evict = shouldEvictSessionCommentsOnError(error);
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          setEntries((previous) => {
            const stored = previous[targetKey];
            const sameIdentity = stored?.identityKey === requestIdentityKey;
            const retained = !evict && sameIdentity ? stored : undefined;
            // Eviction protects cached BODIES, not the failure bookkeeping:
            // resetting the counter on evict-class errors (e.g. a session
            // that is not on the server) would turn the exponential retry
            // back into a flat loop against a persistently failing target.
            const priorFailures = sameIdentity
              ? (stored?.consecutiveFailures ?? 0)
              : 0;
            return writeSessionCommentsEntry(previous, targetKey, {
              ...(retained ?? EMPTY_ENTRY),
              identityKey: requestIdentityKey,
              state: "error",
              errorMessage,
              consecutiveFailures: priorFailures + 1,
              fetchedAt: Date.now(),
            });
          });
        } finally {
          if (forceToken) {
            if (activeForceTokenByKey.get(requestKey) === forceToken) {
              activeForceTokenByKey.delete(requestKey);
            }
            rememberCompletedForceToken(requestKey, forceToken);
          }
        }
        // A force that arrived while THIS fetch was in flight replays as
        // exactly one more forced round-trip. Signal tokens additionally
        // collapse identical requests from multiple mounted subscribers.
        const queuedToken = pendingForceTokenByKey.get(requestKey);
        if (queuedToken) pendingForceTokenByKey.delete(requestKey);
        const queuedUntokened = pendingForceRefetchKeys.delete(requestKey);
        if (!queuedToken && !queuedUntokened) return;
        force = true;
        forceToken = queuedToken;
      }
    },
    [authIdentityKey, setEntries, withFreshToken]
  );

  useEffect(() => {
    if (!orgId || !sessionId || !signedIn) return;
    // TTL + in-flight dedup live inside fetchComments' atomic claim.
    void fetchComments(orgId, sessionId);
  }, [orgId, sessionId, signedIn, fetchComments]);

  const storedEntry = key ? entries[key] : undefined;
  const entry =
    sessionCommentsEntryForIdentity(storedEntry, authIdentityKey) ??
    EMPTY_ENTRY;
  const entryState = entry.state;

  const refresh = useCallback(() => {
    if (!orgId || !sessionId || !signedIn) return;
    void fetchComments(orgId, sessionId, { force: true });
  }, [orgId, sessionId, signedIn, fetchComments]);

  // Error retry: one deferred re-run per error result while a consumer is
  // mounted (the entry's fetchedAt changes on every attempt, re-arming the
  // effect). Not a recurring timer — it exists only while an error shows, and
  // consecutive failures widen the delay exponentially.
  const entryFetchedAt = entry.fetchedAt;
  const entryConsecutiveFailures = entry.consecutiveFailures ?? 1;
  useEffect(() => {
    if (!orgId || !sessionId || !signedIn) return undefined;
    if (entryState !== "error") return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const delayMs = sessionCommentsErrorRetryDelayMs(entryConsecutiveFailures);
    const arm = () => {
      timer = setTimeout(() => {
        // Hidden windows stay network-silent: re-check after the same delay
        // instead of retrying a fetch nobody is looking at.
        if (
          typeof document !== "undefined" &&
          document.visibilityState === "hidden"
        ) {
          arm();
          return;
        }
        void fetchComments(orgId, sessionId, {});
      }, delayMs);
    };
    arm();
    return () => clearTimeout(timer);
  }, [
    orgId,
    sessionId,
    signedIn,
    entryState,
    entryFetchedAt,
    entryConsecutiveFailures,
    fetchComments,
  ]);

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
  // Past generations are covered by the mount/TTL fetch. Seed from the
  // current counters so mounting a second surface never replays old signals.
  const lastSignalRef = useRef({
    session: signalVersion,
    org: orgSignalVersion,
  });
  useEffect(() => {
    if (!orgId || !sessionId || !signedIn) return;
    const sessionChanged = signalVersion !== lastSignalRef.current.session;
    const orgChanged = orgSignalVersion !== lastSignalRef.current.org;
    if (!sessionChanged && !orgChanged) return;
    lastSignalRef.current = {
      session: signalVersion,
      org: orgSignalVersion,
    };
    if (signalVersion === 0 && orgSignalVersion === 0) return;
    if (sessionChanged) {
      void fetchComments(orgId, sessionId, {
        force: true,
        forceToken: `session:${signalVersion}`,
      });
      return;
    }
    // org_change_signals carries unrelated projects, sessions, scopes, and
    // comments. Let the existing TTL gate this coarse event instead of forcing
    // every open session to list comments for every org-level write.
    void fetchComments(orgId, sessionId);
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
      const identityKey = authIdentityKey;
      if (!identityKey) return;
      setEntries((previous) => {
        const latestAuth = authRef.current;
        if (
          !latestAuth ||
          org2CloudAuthIdentityKey(latestAuth) !== identityKey
        ) {
          return previous;
        }
        const stored = previous[targetKey];
        const entry =
          stored?.identityKey === identityKey ? stored : EMPTY_ENTRY;
        return writeSessionCommentsEntry(previous, targetKey, {
          ...entry,
          identityKey,
          comments: transform(entry.comments),
        });
      });
    },
    [authIdentityKey, setEntries]
  );

  const insertLocalComment = useCallback(
    (comment: CloudSessionComment): void => {
      if (!key) return;
      patchEntry(key, (comments) => insertComment(comments, comment));
    },
    [key, patchEntry]
  );

  const freshTokenForCurrentIdentity = useCallback(async () => {
    const identityKey = authIdentityKey;
    if (!identityKey) throw new Error("not signed in to ORG2 Cloud");
    const accessToken = await withFreshToken();
    const latestAuth = authRef.current;
    if (!latestAuth || org2CloudAuthIdentityKey(latestAuth) !== identityKey) {
      throw new Error("ORG2 Cloud identity changed during the request");
    }
    return { accessToken, identityKey };
  }, [authIdentityKey, withFreshToken]);

  const isCurrentIdentity = useCallback((identityKey: string): boolean => {
    const latestAuth = authRef.current;
    return Boolean(
      latestAuth && org2CloudAuthIdentityKey(latestAuth) === identityKey
    );
  }, []);

  const addComment = useCallback(
    async (input: AddCommentInput): Promise<CloudSessionComment> => {
      if (!orgId || !sessionId || !key) {
        throw new Error("no cloud comment target");
      }
      const { accessToken, identityKey } = await freshTokenForCurrentIdentity();
      const comment = await addSessionComment(accessToken, {
        orgId,
        sessionId,
        body: input.body,
        eventId: input.eventId,
        parentId: input.parentId,
        mentionedUserIds: input.mentionedUserIds,
        ...(originSessionId && originSessionId !== sessionId
          ? { originSessionId }
          : {}),
      });
      if (!isCurrentIdentity(identityKey)) return comment;
      // The RPC returns the row in listing shape — insert without a refetch.
      patchEntry(key, (comments) => insertComment(comments, comment));
      broadcastCommentsChangedToPeers(orgId, sessionId);
      return comment;
    },
    [
      orgId,
      sessionId,
      originSessionId,
      key,
      freshTokenForCurrentIdentity,
      isCurrentIdentity,
      patchEntry,
    ]
  );

  const editComment = useCallback(
    async (commentId: string, body: string): Promise<void> => {
      if (!orgId || !key) throw new Error("no cloud comment target");
      const { accessToken, identityKey } = await freshTokenForCurrentIdentity();
      const editedAt = await editSessionComment(
        accessToken,
        orgId,
        commentId,
        body
      );
      if (!isCurrentIdentity(identityKey)) return;
      patchEntry(key, (comments) =>
        patchComment(comments, commentId, { body, editedAt })
      );
      if (sessionId) broadcastCommentsChangedToPeers(orgId, sessionId);
    },
    [
      orgId,
      sessionId,
      key,
      freshTokenForCurrentIdentity,
      isCurrentIdentity,
      patchEntry,
    ]
  );

  const deleteComment = useCallback(
    async (commentId: string): Promise<void> => {
      if (!orgId || !key) throw new Error("no cloud comment target");
      const { accessToken, identityKey } = await freshTokenForCurrentIdentity();
      await deleteSessionComment(accessToken, orgId, commentId);
      if (!isCurrentIdentity(identityKey)) return;
      // Mirror the server's soft delete: stamp + blank body (tombstone).
      patchEntry(key, (comments) =>
        patchComment(comments, commentId, {
          deletedAt: new Date().toISOString(),
          body: "",
        })
      );
      if (sessionId) broadcastCommentsChangedToPeers(orgId, sessionId);
    },
    [
      orgId,
      sessionId,
      key,
      freshTokenForCurrentIdentity,
      isCurrentIdentity,
      patchEntry,
    ]
  );

  const resolveComment = useCallback(
    async (
      commentId: string,
      resolved: boolean,
      resolution?: CloudCommentResolution
    ): Promise<void> => {
      if (!orgId || !key) throw new Error("no cloud comment target");
      const { accessToken, identityKey } = await freshTokenForCurrentIdentity();
      await resolveSessionComment(
        accessToken,
        orgId,
        commentId,
        resolved,
        resolution
      );
      if (!isCurrentIdentity(identityKey)) return;
      patchEntry(key, (comments) =>
        patchComment(comments, commentId, {
          resolvedAt: resolved ? new Date().toISOString() : undefined,
          resolution: resolved ? (resolution ?? "resolved") : undefined,
        })
      );
      if (sessionId) broadcastCommentsChangedToPeers(orgId, sessionId);
    },
    [
      orgId,
      sessionId,
      key,
      freshTokenForCurrentIdentity,
      isCurrentIdentity,
      patchEntry,
    ]
  );

  return {
    comments: entry.comments,
    viewerOwnsSession: entry.viewerOwnsSession,
    state: entry.state,
    refresh,
    insertLocalComment,
    addComment,
    editComment,
    deleteComment,
    resolveComment,
  };
}
