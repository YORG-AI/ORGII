/**
 * SessionCommentsContext — one comments state per mounted chat surface
 * (managed-cloud collaboration design).
 *
 * The provider lives in ChatView (which owns the Session object AND the
 * replay event stream) and resolves the cloud comment target once; the
 * per-turn chrome inside the virtualized transcript consumes the context
 * instead of re-running target resolution + atom subscriptions per group
 * header. NON-cloud sessions get a null context value — every consumer
 * renders nothing, so the ordinary chat surface is untouched.
 *
 * Context (not a global atom) on purpose: multiple ChatViews can be
 * mounted at once (split panes / editor tabs) and each needs its own
 * target. The one cross-tree bridge — the replay stream's event-id set,
 * needed by the HEADER notes dialog to bucket orphaned anchors — is a
 * session-id-keyed registry atom written here and read by
 * `SessionCommentsHeaderExtras` (the header renders outside ChatView).
 */
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import type { ComposerSnapshot } from "@src/components/ComposerInput";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import { stripCopyEventNamespace } from "../../TeamCollaboration/copyEventId";
import { getSessionForkedFrom } from "../../TeamCollaboration/forkSession";
import {
  isTeamChatBodyWithinLimit,
  isTeamChatMentionAudienceWithinLimit,
  resolveTeamChatMentionedUserIds,
} from "../SessionConversation/teamChatMentions";
import { collectAddressableThreads } from "../addressComments";
import { addressRunActiveAtom } from "../addressCommentsRun";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../org2CloudAuthAtom";
import { getCloudCapabilities } from "../org2CloudCapabilities";
import type { CloudOrgMember } from "../org2CloudClient";
import {
  CLOUD_COMMENT_MAX_BODY_LENGTH,
  CLOUD_COMMENT_MAX_MENTIONED_USER_IDS,
  type CloudCommentResolution,
  type CloudSessionComment,
  isOrg2CommentErrorCode,
} from "../org2CloudCommentsClient";
import { loadCloudOrgMembers } from "../org2CloudMembersCoordinator";
import {
  org2CloudOrgsAtom,
  org2CloudRosterVersionAtom,
} from "../org2CloudOrgsAtom";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "../org2CloudRemoteSessionsAtom";
import {
  type AddCommentInput,
  type CloudSessionCommentsFetchState,
  type GroupedCommentThreads,
  OPTIMISTIC_SESSION_COMMENT_ID_PREFIX,
  SessionCommentDeliveryError,
  groupCommentThreads,
  useSessionComments,
} from "../org2CloudSessionCommentsAtom";
import { org2CloudSyncEngine } from "../org2CloudSyncEngine";
import {
  type SessionCommentTarget,
  useSessionCommentTarget,
} from "../sessionCommentTarget";
import { useOwnedCloudCommentAgentRun } from "../useOwnedCloudCommentAgentRun";
import type { CommentAnchorEventIdentity } from "./commentAnchorIdentities";

const CLOUD_ADMIN_ROLES = new Set(["owner", "admin"]);
const RUST_NATIVE_TRANSIENT_USER_EVENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeCloudCommentRetryAttempts = new Map<string, symbol>();

export function cloudCommentRetryAttemptKey(input: {
  authIdentityKey: string;
  orgId: string;
  sessionId: string;
  commentId: string;
}): string {
  return [
    input.authIdentityKey,
    input.orgId,
    input.sessionId,
    input.commentId,
  ].join("\u001f");
}

interface CloudCommentRetryCasStep {
  body: string;
  mentionedUserIds: string[];
  replaceExisting: boolean;
  expectedBody?: string;
  expectedMentionedUserIds?: string[];
}

function sameMentionedUserIds(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Plan an idempotent retry without guessing which side of a lost response
 * Cloud committed. If an earlier edited retry changed A -> B but its response
 * was lost, a later edit to C must first replay/confirm A -> B and only then
 * CAS B -> C. Sending C with expected A directly would conflict forever when
 * Cloud already contains B.
 */
export function buildCloudCommentRetryCasSteps(input: {
  failed: Pick<
    CloudSessionComment,
    | "body"
    | "mentionedUserIds"
    | "clientRetryExpectedBody"
    | "clientRetryExpectedMentionedUserIds"
  >;
  nextBody: string;
  nextMentionedUserIds: readonly string[];
  edited: boolean;
}): CloudCommentRetryCasStep[] {
  const currentMentionedUserIds = [...(input.failed.mentionedUserIds ?? [])];
  const nextMentionedUserIds = [...input.nextMentionedUserIds];
  const originalExpectedBody = input.failed.clientRetryExpectedBody;
  const originalExpectedMentionedUserIds = [
    ...(input.failed.clientRetryExpectedMentionedUserIds ??
      currentMentionedUserIds),
  ];
  const changedAgain =
    input.edited &&
    (input.nextBody !== input.failed.body ||
      !sameMentionedUserIds(nextMentionedUserIds, currentMentionedUserIds));

  if (originalExpectedBody !== undefined && changedAgain) {
    return [
      {
        body: input.failed.body,
        mentionedUserIds: currentMentionedUserIds,
        replaceExisting: true,
        expectedBody: originalExpectedBody,
        expectedMentionedUserIds: originalExpectedMentionedUserIds,
      },
      {
        body: input.nextBody,
        mentionedUserIds: nextMentionedUserIds,
        replaceExisting: true,
        expectedBody: input.failed.body,
        expectedMentionedUserIds: currentMentionedUserIds,
      },
    ];
  }

  const replaceExisting = input.edited || originalExpectedBody !== undefined;
  return [
    {
      body: input.nextBody,
      mentionedUserIds: nextMentionedUserIds,
      replaceExisting,
      ...(replaceExisting
        ? {
            expectedBody: originalExpectedBody ?? input.failed.body,
            expectedMentionedUserIds:
              originalExpectedBody !== undefined
                ? originalExpectedMentionedUserIds
                : currentMentionedUserIds,
          }
        : {}),
    },
  ];
}

function claimCloudCommentRetryAttempt(key: string): symbol | null {
  if (activeCloudCommentRetryAttempts.has(key)) return null;
  const attempt = Symbol(key);
  activeCloudCommentRetryAttempts.set(key, attempt);
  return attempt;
}

function releaseCloudCommentRetryAttempt(key: string, attempt: symbol): void {
  if (activeCloudCommentRetryAttempts.get(key) === attempt) {
    activeCloudCommentRetryAttempts.delete(key);
  }
}

export type { CommentAnchorEventIdentity };

/**
 * A repo-scope/tag can make Team Chat available a few milliseconds before
 * the owner push creates the Cloud session row. Repair that one admission
 * race through the existing sync engine, then retry the exact comment once.
 * Imported teammate sessions deliberately pass no repair callback.
 */
export async function addCommentWithSessionAdmissionRecovery(
  add: () => Promise<CloudSessionComment>,
  repair: (() => Promise<void>) | null
): Promise<CloudSessionComment> {
  try {
    return await add();
  } catch (error) {
    const cause =
      error instanceof SessionCommentDeliveryError ? error.cause : error;
    if (!repair || !isOrg2CommentErrorCode(cause, "ORG2_SESSION_NOT_FOUND")) {
      throw error;
    }
    try {
      await repair();
    } catch (repairError) {
      if (error instanceof SessionCommentDeliveryError) {
        throw new SessionCommentDeliveryError(error.commentId, repairError);
      }
      throw repairError;
    }
    // `add` carries the same optimisticId, so the replay re-sends the very
    // row the first attempt retained instead of creating a second one.
    return add();
  }
}

/**
 * Build the local-render id -> durable cloud-anchor id projection once per
 * transcript. Rust-native live broadcasts briefly expose a bare message UUID,
 * while the persisted event uploaded to cloud is `user-message-${uuid}`.
 * Imports/forks additionally namespace that durable id with their local
 * session id. Comments must use the durable source-plane spelling in all
 * three states or a thread posted during the live turn disappears on reload
 * and cannot be seen by an imported replay.
 */
export function buildCloudCommentSourceEventIdMap(
  session: Pick<Session, "session_id" | "category">,
  events: readonly CommentAnchorEventIdentity[]
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    const bareEventId = stripCopyEventNamespace(session.session_id, event.id);
    const sourceEventId =
      session.category === "rust_agent" &&
      event.source === "user" &&
      RUST_NATIVE_TRANSIENT_USER_EVENT_ID.test(bareEventId)
        ? `user-message-${bareEventId}`
        : bareEventId;
    result.set(event.id, sourceEventId);
  }
  return result;
}

/**
 * Replay-stream event ids per LOCAL session id, registered by every mounted
 * provider — keyed session id → PROVIDER INSTANCE id → id set, because two
 * panes can show the SAME session (split panes / editor tabs) and a single
 * slot per session would let whichever pane unmounts first delete the
 * surviving pane's entry (silently emptying the header dialog's orphan
 * bucket). Readers merge the instances via `mergePresentEventIdEntries`;
 * a missing/empty session entry means "presence unknown" and
 * `groupCommentThreads` then never classifies orphans.
 */
export const sessionCommentPresentEventIdsAtom = atom<
  Record<string, Record<string, ReadonlySet<string>>>
>({});
sessionCommentPresentEventIdsAtom.debugLabel =
  "sessionCommentPresentEventIdsAtom";

export interface SessionCommentsContextValue {
  target: SessionCommentTarget;
  state: CloudSessionCommentsFetchState;
  /** Raw rows used by the shared canonical timeline assembler. */
  comments: readonly CloudSessionComment[];
  grouped: GroupedCommentThreads;
  /**
   * Map a local (possibly fork/import-namespaced) event id to the source-plane
   * event id comments anchor by. Identity for ordinary sessions.
   */
  toSourceEventId: (eventId: string) => string;
  /**
   * False when the rendered transcript is not this session's own stream
   * (group-chat merged view) — TurnCommentChrome renders nothing.
   */
  turnAnchorsVisible: boolean;
  /**
   * False when the cloud row says the session is NOT full_replay —
   * turn-anchored composers disable with a tooltip (the server enforces
   * regardless; UI mirrors it). Unknown rows default to true.
   */
  canAnchorTurns: boolean;
  viewerUserId: string | null;
  /** Org admin/owner — may delete any comment (moderation surface). */
  viewerIsAdmin: boolean;
  /** Active org members available for identity-stable mentions. */
  mentionableMembers: readonly CloudOrgMember[];
  refresh: () => void;
  addComment: (input: AddCommentInput) => Promise<CloudSessionComment>;
  /** Retry a visible failed Team Chat row, optionally with edited text. */
  retryComment: (
    commentId: string,
    editedBody?: string,
    composerSnapshot?: ComposerSnapshot
  ) => Promise<void>;
  /**
   * Batch follow-up (design 2026-07-11): address every unresolved thread as
   * one owner-only agent round, then post one parsed reply per thread. A
   * writable source/fork runs in place; immutable owner history first forks.
   * Null ⇒ not available here (non-owner/import or nothing unresolved).
   */
  addressAllComments: (() => Promise<void>) | null;
  addressRunActive: boolean;
  /** Null means every unresolved thread; otherwise only these heads are live. */
  addressRunSelectedHeadIds: ReadonlySet<string> | null;
  unresolvedThreadCount: number;
  editComment: (commentId: string, body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  resolveComment: (
    commentId: string,
    resolved: boolean,
    resolution?: CloudCommentResolution
  ) => Promise<void>;

  /**
   * Fail-open like `canAnchorTurns`: the server is the real gate
   * (readable guard + `forkSharedSessionEnabled` at claim). False only on
   * the one locally-KNOWN blocker — no signed-in cloud user.
   */
  canRunAgent: boolean;
  /** Run a personal @agent round for this comment on the local session. */
  requestAgent: (commentId: string, instruction?: string) => Promise<void>;
}

const SessionCommentsContext =
  createContext<SessionCommentsContextValue | null>(null);

export function useSessionCommentsContext(): SessionCommentsContextValue | null {
  return useContext(SessionCommentsContext);
}

/**
 * Roster reads share the app-wide coordinator and are keyed by account,
 * endpoint, org, and roster revision. Late identity responses are discarded.
 */
export function useSessionCommentMentionableMembers(
  target: SessionCommentTarget | null
): readonly CloudOrgMember[] {
  const store = useStore();
  const auth = useAtomValue(org2CloudAuthAtom);
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const rosterVersions = useAtomValue(org2CloudRosterVersionAtom);
  const identityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const orgId = target?.orgId ?? null;
  const rosterVersion = orgId ? (rosterVersions[orgId] ?? 0) : 0;
  const requestKey =
    identityKey && orgId ? `${identityKey}|${orgId}|${rosterVersion}` : null;
  const [resolved, setResolved] = useState<{
    key: string;
    members: CloudOrgMember[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth || !identityKey || !orgId || !requestKey) return;
    const requestAuth = auth;
    void Promise.all([
      loadCloudOrgMembers(store, requestAuth, orgId, rosterVersion),
      getCloudCapabilities(requestAuth.accessToken),
    ])
      .then(([loaded, capabilities]) => {
        if (!loaded || cancelled) return;
        commitRefreshedAuth(setAuth, requestAuth, loaded.auth);
        const latestAuth = store.get(org2CloudAuthAtom);
        if (
          !latestAuth ||
          org2CloudAuthIdentityKey(latestAuth) !== identityKey ||
          (store.get(org2CloudRosterVersionAtom)[orgId] ?? 0) > rosterVersion
        ) {
          return;
        }
        setResolved({
          key: requestKey,
          members: capabilities.teamInboxMentions
            ? loaded.members.filter((member) => member.status === "active")
            : [],
        });
      })
      .catch(() => {
        if (!cancelled) setResolved({ key: requestKey, members: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [auth, identityKey, orgId, requestKey, rosterVersion, setAuth, store]);

  return resolved?.key === requestKey ? resolved.members : [];
}

/**
 * Viewer-side capability probes shared by the provider and the header
 * extras (which runs its own instance because it mounts outside ChatView).
 */
export function useSessionCommentViewer(target: SessionCommentTarget | null): {
  viewerUserId: string | null;
  viewerIsAdmin: boolean;
  canAnchorTurns: boolean;
} {
  const auth = useAtomValue(org2CloudAuthAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);

  return useMemo(() => {
    const role = target
      ? cloudOrgs.find((org) => org.orgId === target.orgId)?.role
      : undefined;
    // Identity-filtered like every other remote-sessions read: a stale row
    // from a previous account must not decide anchor capability (fail-open
    // covers the filtered-out case).
    const row = target
      ? remoteSessionsEntryForIdentity(
          remoteEntries[target.orgId],
          auth ? org2CloudAuthIdentityKey(auth) : null
        )?.rows.find(
          (candidate) => candidate.sourceSessionId === target.sessionId
        )
      : undefined;
    return {
      viewerUserId: auth?.userId ?? null,
      viewerIsAdmin: Boolean(role && CLOUD_ADMIN_ROLES.has(role)),
      // Row unknown (listing not fetched yet) fails OPEN — the server is
      // the real gate (ORG2_REPLAY_NOT_AVAILABLE) and a stale disable
      // would block legitimate anchors.
      canAnchorTurns: row?.accessMode
        ? row.accessMode === COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
        : true,
    };
  }, [target, auth, cloudOrgs, remoteEntries]);
}

export interface SessionCommentsProviderProps {
  session: Session | null | undefined;
  /** Canonical Cloud conversation coordinates carried by a native episode. */
  targetOverride?: SessionCommentTarget | null;
  /**
   * Events currently present in the replay stream (anchor presence for
   * orphan bucketing). `null` = presence UNKNOWN (snapshot not hydrated
   * yet) — threads must not be bucketed as orphans off an empty pre-load
   * set. Only the ids are read, and only for cloud targets — ordinary
   * sessions never pay the id-set build.
   */
  events: readonly CommentAnchorEventIdentity[] | null;
  /**
   * False when the rendered transcript is NOT this session's own stream
   * (agent-org group-chat view merges member-session events, whose ids can
   * never anchor into THIS session) — turn chrome hides; the header Notes
   * dialog stays available.
   */
  turnAnchorsVisible?: boolean;
  children?: React.ReactNode;
}

export const SessionCommentsProvider: React.FC<
  SessionCommentsProviderProps
> = ({
  session,
  targetOverride,
  events,
  turnAnchorsVisible = true,
  children,
}) => {
  const target = useSessionCommentTarget(session, targetOverride);
  const retryAuth = useAtomValue(org2CloudAuthAtom);
  const retryAuthIdentityKey = retryAuth
    ? org2CloudAuthIdentityKey(retryAuth)
    : null;
  // Comments live on the SOURCE session's plane, anchored by the raw source
  // event id shared across all users. A fork/import copy carries namespaced
  // local ids, so anchor matching must happen in source-id space.
  const localSessionId = target ? (session?.session_id ?? null) : null;
  // Origin attribution is for per-fork counts, so it is stamped ONLY for a
  // writable fork. An import (read-only replay) or a plain tagged session must
  // not create a bogus origin bucket — they coalesce to the source at count
  // time.
  const originSessionId =
    session && getSessionForkedFrom(session) ? localSessionId : null;
  const sourceEventIdByLocalId = useMemo(
    () =>
      target && session && events
        ? buildCloudCommentSourceEventIdMap(session, events)
        : null,
    [target, session, events]
  );
  const toSourceEventId = useCallback(
    (eventId: string) =>
      sourceEventIdByLocalId?.get(eventId) ??
      (localSessionId
        ? stripCopyEventNamespace(localSessionId, eventId)
        : eventId),
    [sourceEventIdByLocalId, localSessionId]
  );
  const presentEventIds = useMemo<ReadonlySet<string> | null>(
    () =>
      target && events
        ? new Set(events.map((event) => toSourceEventId(event.id)))
        : null,
    [target, events, toSourceEventId]
  );
  const {
    comments,
    viewerOwnsSession,
    state,
    refresh,
    addComment,
    editComment,
    deleteComment,
    resolveComment,
  } = useSessionComments(
    target?.orgId ?? null,
    target?.sessionId ?? null,
    originSessionId
  );
  const addCommentWithRecovery = useCallback(
    (input: AddCommentInput): Promise<CloudSessionComment> => {
      const stableInput: AddCommentInput = {
        ...input,
        optimisticId:
          input.optimisticId ??
          `${OPTIMISTIC_SESSION_COMMENT_ID_PREFIX}${crypto.randomUUID()}`,
      };
      const locallyOwnedTarget = Boolean(
        session &&
        target &&
        session.session_id === target.sessionId &&
        !session.importedFrom &&
        !getSessionForkedFrom(session)
      );
      return addCommentWithSessionAdmissionRecovery(
        () => addComment(stableInput),
        locallyOwnedTarget && target
          ? async () => {
              org2CloudSyncEngine.invalidatePushedMetadataHash(
                target.orgId,
                target.sessionId
              );
              await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
            }
          : null
      );
    },
    [addComment, session, target]
  );
  const mentionableMembers = useSessionCommentMentionableMembers(target);
  const retryComment = useCallback(
    async (
      commentId: string,
      editedBody?: string,
      composerSnapshot?: ComposerSnapshot
    ): Promise<void> => {
      const failed = comments.find((comment) => comment.id === commentId);
      if (
        !target ||
        !retryAuth ||
        !retryAuthIdentityKey ||
        !failed ||
        failed.clientDeliveryStatus !== "failed"
      ) {
        return;
      }
      const body = editedBody ?? failed.body;
      if (!isTeamChatBodyWithinLimit(body)) {
        throw new Error(
          `Team Chat messages must be ${CLOUD_COMMENT_MAX_BODY_LENGTH} characters or fewer`
        );
      }
      // The atom update that flips failed -> pending is visible on the next
      // render. Claim synchronously across every provider/pane as well so two
      // retry clicks in that window cannot issue duplicate Cloud writes. The
      // attempt token makes cleanup compare-and-swap safe across remounts.
      // Endpoint/account identity is part of the key: an old request must not
      // block or release the same logical row after an auth switch.
      const retryKey = cloudCommentRetryAttemptKey({
        authIdentityKey: retryAuthIdentityKey,
        orgId: target.orgId,
        sessionId: target.sessionId,
        commentId,
      });
      const attempt = claimCloudCommentRetryAttempt(retryKey);
      if (!attempt) return;
      try {
        const mentionedUserIds =
          editedBody === undefined
            ? (failed.mentionedUserIds ?? [])
            : resolveTeamChatMentionedUserIds(
                body,
                mentionableMembers,
                composerSnapshot,
                retryAuth.userId
              );
        if (!isTeamChatMentionAudienceWithinLimit(mentionedUserIds)) {
          throw new Error(
            `@all is unavailable when it would notify more than ${CLOUD_COMMENT_MAX_MENTIONED_USER_IDS} people`
          );
        }
        const steps = buildCloudCommentRetryCasSteps({
          failed,
          nextBody: body,
          nextMentionedUserIds: mentionedUserIds,
          edited: editedBody !== undefined,
        });
        for (const step of steps) {
          await addCommentWithRecovery({
            ...step,
            eventId: failed.eventId,
            parentId: failed.parentId,
            optimisticId: failed.id,
          });
        }
      } finally {
        releaseCloudCommentRetryAttempt(retryKey, attempt);
      }
    },
    [
      addCommentWithRecovery,
      comments,
      mentionableMembers,
      retryAuth,
      retryAuthIdentityKey,
      target,
    ]
  );
  const viewer = useSessionCommentViewer(target);
  const setPresentRegistry = useSetAtom(sessionCommentPresentEventIdsAtom);

  // Publish the replay stream's event ids for the header notes dialog —
  // only for cloud targets, so ordinary sessions cause zero registry churn.
  // Keyed by PROVIDER INSTANCE under the session id: two panes on the same
  // session each own their sub-entry, so the first pane to unmount can
  // never delete the surviving pane's ids (readers union the instances).
  const providerId = useId();
  useEffect(() => {
    if (!localSessionId || !presentEventIds) return;
    setPresentRegistry((previous) => ({
      ...previous,
      [localSessionId]: {
        ...previous[localSessionId],
        [providerId]: presentEventIds,
      },
    }));
    return () => {
      setPresentRegistry((previous) => {
        const forSession = previous[localSessionId];
        if (!forSession || !(providerId in forSession)) return previous;
        const { [providerId]: _removed, ...restInstances } = forSession;
        if (Object.keys(restInstances).length === 0) {
          const { [localSessionId]: _session, ...restSessions } = previous;
          return restSessions;
        }
        return { ...previous, [localSessionId]: restInstances };
      });
    };
  }, [localSessionId, presentEventIds, providerId, setPresentRegistry]);

  const grouped = useMemo(
    () => groupCommentThreads(comments, presentEventIds),
    [comments, presentEventIds]
  );

  const { available: ownerAgentAvailable, run: runOwnerAgent } =
    useOwnedCloudCommentAgentRun({
      session,
      target,
      viewerOwnsSession,
      onFinished: refresh,
    });

  const requestAgent = useCallback(
    async (commentId: string, instruction?: string): Promise<void> => {
      await runOwnerAgent({
        selectedHeadIds: [commentId],
        ...(instruction !== undefined ? { instruction } : {}),
      });
    },
    [runOwnerAgent]
  );

  // --- Address comments (batch owner-only follow-up) ---
  const addressRunActiveMap = useAtomValue(addressRunActiveAtom);
  const addressRunActivity = localSessionId
    ? addressRunActiveMap[localSessionId]
    : undefined;
  const addressRunActive = addressRunActivity !== undefined;
  const addressRunSelectedHeadIds = useMemo(
    () =>
      addressRunActivity?.selectedHeadIds === null ||
      addressRunActivity === undefined
        ? null
        : new Set(addressRunActivity.selectedHeadIds),
    [addressRunActivity]
  );
  const addressableThreads = useMemo(
    () => collectAddressableThreads(comments),
    [comments]
  );
  const unresolvedThreadCount = addressableThreads.length;
  const canAddressComments = Boolean(
    ownerAgentAvailable && unresolvedThreadCount > 0
  );

  const addressAllCommentsImpl = useCallback(async (): Promise<void> => {
    await runOwnerAgent();
  }, [runOwnerAgent]);

  const value = useMemo<SessionCommentsContextValue | null>(() => {
    if (!target) return null;
    return {
      target,
      state,
      comments,
      grouped,
      toSourceEventId,
      turnAnchorsVisible,
      canAnchorTurns: viewer.canAnchorTurns,
      viewerUserId: viewer.viewerUserId,
      viewerIsAdmin: viewer.viewerIsAdmin,
      mentionableMembers,
      refresh,
      addComment: addCommentWithRecovery,
      retryComment,
      editComment,
      deleteComment,
      resolveComment,
      canRunAgent: viewer.viewerUserId !== null && ownerAgentAvailable,
      requestAgent,
      addressAllComments: canAddressComments ? addressAllCommentsImpl : null,
      addressRunActive,
      addressRunSelectedHeadIds,
      unresolvedThreadCount,
    };
  }, [
    target,
    state,
    comments,
    grouped,
    toSourceEventId,
    turnAnchorsVisible,
    viewer,
    mentionableMembers,
    refresh,
    addCommentWithRecovery,
    retryComment,
    editComment,
    deleteComment,
    resolveComment,
    requestAgent,
    ownerAgentAvailable,
    canAddressComments,
    addressAllCommentsImpl,
    addressRunActive,
    addressRunSelectedHeadIds,
    unresolvedThreadCount,
  ]);

  return (
    <SessionCommentsContext.Provider value={value}>
      {children}
    </SessionCommentsContext.Provider>
  );
};
