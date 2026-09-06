import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { resolveConversationViewerState } from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import {
  type ConversationRootLocator,
  conversationRootKey,
} from "@src/engines/SessionCore/conversations/conversationTypes";
import {
  type LocalCanonicalConversationSnapshot,
  type LocalExecutionSegment,
  loadLocalCanonicalConversationSnapshot,
  projectVerifiedLocalExecutionTail,
  suppressLandedQueuedUserRows,
  suppressLandedRowsOfFailedQueuedTurns,
} from "@src/engines/SessionCore/conversations/localConversationExecutionTail";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { derivePlanDisplayEvents } from "@src/engines/SessionCore/derived/planDisplayEvents";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { isVisibleInChat } from "@src/engines/SessionCore/ingestion/visibilityFilters";
import { useSessionCommentsContext } from "@src/features/Org2Cloud/SessionComments/SessionCommentsContext";
import {
  assembleCanonicalConversationTimeline,
  legacyConversationFamilyForTimeline,
} from "@src/features/Org2Cloud/SessionConversation/canonicalConversationTimeline";
import {
  type ConversationFamilyMember,
  resolveConversationFamily,
} from "@src/features/Org2Cloud/SessionConversation/continuationEvents";
import { useConversationPlaneEvents } from "@src/features/Org2Cloud/SessionConversation/conversationPlaneAtom";
import {
  buildConversationRunnerOverlay,
  collectLandedTurnIds,
  conversationRunnerOverlaysEqual,
} from "@src/features/Org2Cloud/SessionConversation/conversationRunnerOverlay";
import { mergeConversationEvents } from "@src/features/Org2Cloud/SessionConversation/discussionEvents";
import { useEnsureFamilyLoaded } from "@src/features/Org2Cloud/SessionConversation/useEnsureFamilyLoaded";
import { useMarkDiscussionSeen } from "@src/features/Org2Cloud/SessionConversation/useMarkDiscussionSeen";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import {
  findImportedSession,
  normalizeSourceEndpointUrl,
} from "@src/features/TeamCollaboration/engine/collabImportIdentity";
import { getSessionForkedFrom } from "@src/features/TeamCollaboration/forkSession";
import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { sessionByIdAtom, sessionsAtom } from "@src/store/session";
import {
  type ActiveMessageDelivery,
  activeMessageDeliveriesAtom,
} from "@src/store/ui/messageQueueAtom";

import { ChatHistoryOverrideContext } from "./ChatHistoryOverrideContext";
import {
  conversationRootForSession,
  conversationSourceFromImportedHistory,
} from "./hooks/useConversationTargetBinding";

const EMPTY_DISCUSSION_COMMENTS = [] as const;
const EMPTY_LOCAL_EXECUTION_SEGMENTS: readonly LocalExecutionSegment[] = [];
const EMPTY_SESSION_EVENTS: readonly SessionEvent[] = [];
const log = createLogger("ConversationStreamProvider");

interface ConversationDeliveryScope {
  cloudRootKey: string | null;
  cloudIdentityKey: string | null;
  localRootKey: string | null;
}

function activeDeliveriesEqual(
  left: readonly ActiveMessageDelivery[],
  right: readonly ActiveMessageDelivery[]
): boolean {
  return (
    left.length === right.length &&
    left.every((delivery, index) => delivery === right[index])
  );
}

export function selectConversationActiveDeliveries(
  deliveries: readonly ActiveMessageDelivery[],
  scope: ConversationDeliveryScope
): ActiveMessageDelivery[] {
  return deliveries.filter((delivery) => {
    const descriptor = delivery.conversationDispatch;
    const rootKey = conversationRootKey(descriptor.root);
    if (scope.localRootKey && rootKey === scope.localRootKey) return true;
    return Boolean(
      scope.cloudRootKey &&
      scope.cloudIdentityKey &&
      rootKey === scope.cloudRootKey &&
      descriptor.dispatchIdentityKey === scope.cloudIdentityKey
    );
  });
}

export function conversationActiveDeliveriesAtom(
  scope: ConversationDeliveryScope
) {
  return selectAtom(
    activeMessageDeliveriesAtom,
    (deliveries) => selectConversationActiveDeliveries(deliveries, scope),
    activeDeliveriesEqual
  );
}

interface LatestHydrationRequest<T> {
  generation: number;
  value: T;
}

interface LocalExecutionHydrationCoordinator<TRequest> {
  request: (request: TRequest) => void;
  invalidate: () => void;
  activate: () => void;
  deactivate: () => void;
}

/**
 * Runs at most one native-history hydration at a time and coalesces bursts to
 * the newest request. Generation checks prevent an old root from committing.
 */
export function createLocalExecutionHydrationCoordinator<TRequest, TResult>(
  hydrate: (request: TRequest) => Promise<TResult>,
  onCurrent: (result: TResult, request: TRequest) => void,
  onError: (error: unknown, request: TRequest) => void
): LocalExecutionHydrationCoordinator<TRequest> {
  let generation = 0;
  let active = true;
  let running = false;
  let pending: LatestHydrationRequest<TRequest> | null = null;

  const drain = async () => {
    while (active && pending) {
      const current = pending;
      pending = null;
      try {
        const result = await hydrate(current.value);
        if (active && current.generation === generation) {
          onCurrent(result, current.value);
        }
      } catch (error) {
        if (active && current.generation === generation) {
          onError(error, current.value);
        }
      }
    }
    running = false;
    // No await occurs between the loop condition and this assignment, but keep
    // the restart guard explicit so future scheduling changes cannot lose work.
    if (active && pending) start();
  };
  const start = () => {
    if (!active || running || !pending) return;
    running = true;
    void drain();
  };

  return {
    request(request) {
      generation += 1;
      pending = { generation, value: request };
      start();
    },
    invalidate() {
      generation += 1;
      pending = null;
    },
    activate() {
      active = true;
      start();
    },
    deactivate() {
      active = false;
      generation += 1;
      pending = null;
    },
  };
}

interface LocalExecutionHydrationRequest {
  root: ConversationRootLocator;
  rootKey: string;
}

interface LocalExecutionHydrationSnapshot {
  rootKey: string;
  snapshot: LocalCanonicalConversationSnapshot;
}

interface LocalExecutionHydrationTrigger {
  rootKey: string | null;
  activeDeliveryCount: number;
}

/**
 * Native history is immutable during a queued turn from this projection's
 * perspective: the live runner overlay owns in-flight output. Rehydrate when
 * the root changes or a delivery leaves (its native suffix has settled), not
 * when a delivery starts or the root Session object streams metadata updates.
 */
export function shouldHydrateLocalExecutionSnapshot(
  previous: LocalExecutionHydrationTrigger | null,
  next: LocalExecutionHydrationTrigger
): boolean {
  if (!next.rootKey) return false;
  return (
    previous === null ||
    previous.rootKey !== next.rootKey ||
    next.activeDeliveryCount < previous.activeDeliveryCount
  );
}

async function hydrateLocalExecutionSnapshot(
  request: LocalExecutionHydrationRequest
): Promise<LocalExecutionHydrationSnapshot> {
  return {
    rootKey: request.rootKey,
    snapshot: await loadLocalCanonicalConversationSnapshot(request.root),
  };
}

interface ConversationActiveRunner {
  runnerSessionId: string;
  turnId: string;
  eventStartIndex: number;
}

export function selectConversationActiveRunners(
  deliveries: readonly ActiveMessageDelivery[],
  scope: ConversationDeliveryScope & { landedTurnIds: ReadonlySet<string> }
): ConversationActiveRunner[] {
  return deliveries.flatMap((delivery) => {
    const descriptor = delivery.conversationDispatch;
    const rootKey = conversationRootKey(descriptor.root);
    const isLocal = Boolean(
      scope.localRootKey && rootKey === scope.localRootKey
    );
    const isCloud = Boolean(
      scope.cloudRootKey &&
      scope.cloudIdentityKey &&
      rootKey === scope.cloudRootKey &&
      descriptor.dispatchIdentityKey === scope.cloudIdentityKey
    );
    if (
      (!isLocal && !isCloud) ||
      (isCloud && scope.landedTurnIds.has(delivery.turnIntentId)) ||
      !delivery.runnerSessionId ||
      delivery.runnerEventStartIndex === undefined
    ) {
      return [];
    }
    return [
      {
        runnerSessionId: delivery.runnerSessionId,
        turnId: delivery.turnIntentId,
        eventStartIndex: delivery.runnerEventStartIndex,
      },
    ];
  });
}

/** Verify against raw native history, then run the ordinary chat projection. */
export function projectVisibleLocalExecutionTail(
  authoritativeRootEvents: readonly SessionEvent[],
  segments: readonly LocalExecutionSegment[],
  canonicalSessionId: string
): SessionEvent[] {
  return derivePlanDisplayEvents(
    projectVerifiedLocalExecutionTail(
      authoritativeRootEvents,
      segments,
      canonicalSessionId
    ).filter(isVisibleInChat)
  );
}

interface ConversationStreamProviderProps {
  sessionId: string;
  /** Pre-merged group-chat stream; takes precedence over conversation merging. */
  overrideEvents: SessionEvent[] | undefined;
  children: (activeRunnerSessionId: string | null) => React.ReactNode;
}

export function resolveConversationRunnerBindings(
  sourceSessionId: string,
  activeRunnerSessionId: string | null
): {
  sourceSessionId: string;
  controlSessionId: string | null;
  planningIndicatorScope: { sessionId: string; isLive: true } | null;
} {
  return {
    sourceSessionId,
    controlSessionId: activeRunnerSessionId,
    planningIndicatorScope: activeRunnerSessionId
      ? { sessionId: activeRunnerSessionId, isLive: true }
      : null,
  };
}

interface MemberEventsTapProps {
  bareSessionId: string;
  localSessionId: string;
  onEvents: (bareSessionId: string, events: SessionEvent[]) => void;
  onUnmount?: (bareSessionId: string) => void;
}

/** Invisible per-family-member subscription; the atom self-hydrates on mount. */
function MemberEventsTap({
  bareSessionId,
  localSessionId,
  onEvents,
  onUnmount,
}: MemberEventsTapProps): null {
  const events = useAtomValue(chatEventsForSessionAtomFamily(localSessionId));
  React.useEffect(() => {
    onEvents(bareSessionId, events);
  }, [bareSessionId, events, onEvents]);
  React.useEffect(
    () => () => {
      onUnmount?.(bareSessionId);
    },
    [bareSessionId, onUnmount]
  );
  return null;
}

/**
 * Feeds ChatHistory the conversation stream: pre-plane compatibility
 * segments plus the canonical Cloud plane and discussion rows. Post-plane
 * execution episodes are not subscribed as additional transcript owners.
 * Must render inside `SessionCommentsProvider`.
 */
export function ConversationStreamProvider({
  sessionId,
  overrideEvents,
  children,
}: ConversationStreamProviderProps): React.ReactElement {
  const pipelineSessionId = useAtomValue(sessionIdAtom);
  const chatEvents = useAtomValue(
    chatEventsForSessionAtomFamily(pipelineSessionId ?? sessionId)
  );
  const comments = useSessionCommentsContext();
  const currentSession = useAtomValue(sessionByIdAtom(sessionId));
  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);
  const sessions = useAtomValue(sessionsAtom);
  const auth = useAtomValue(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;

  const target = comments?.target ?? null;
  const discussionComments = comments?.comments ?? EMPTY_DISCUSSION_COMMENTS;
  const toSourceEventId = comments?.toSourceEventId ?? null;
  const anchorBareSessionId =
    currentSession?.importedFrom?.sourceSessionId ?? sessionId;

  const family = useMemo(() => {
    if (!target || overrideEvents) return null;
    const rows = remoteSessionsEntryForIdentity(
      remoteEntries[target.orgId],
      authIdentityKey
    )?.rows;
    if (!rows?.length) return null;
    const resolved = resolveConversationFamily(rows, anchorBareSessionId);
    if (resolved) return resolved;
    // A just-created fork has no cloud row until its first push lands, so
    // the listing alone cannot place it in a family — and without a family
    // the inherited rows render unstamped ("Shared user"). Synthesize the
    // membership from the LOCAL lineage: the root's listing row plus a
    // pseudo-row for this session owned by the signed-in viewer.
    const lineage = currentSession
      ? getSessionForkedFrom(currentSession)
      : undefined;
    const rootSessionId = lineage?.rootSessionId ?? lineage?.sourceSessionId;
    if (!lineage || !rootSessionId || rootSessionId === anchorBareSessionId) {
      return null;
    }
    const rootFamily =
      resolveConversationFamily(rows, rootSessionId) ??
      (() => {
        const rootRow = rows.find(
          (row) => row.sourceSessionId === rootSessionId
        );
        return rootRow
          ? [{ bareSessionId: rootSessionId, row: rootRow, isRoot: true }]
          : null;
      })();
    if (!rootFamily) return null;
    if (
      rootFamily.some((member) => member.bareSessionId === anchorBareSessionId)
    ) {
      return rootFamily;
    }
    const selfMember: ConversationFamilyMember = {
      bareSessionId: anchorBareSessionId,
      isRoot: false,
      row: {
        id: `local-${anchorBareSessionId}`,
        orgId: target.orgId,
        sourceSessionId: anchorBareSessionId,
        ownerUserId: auth?.userId ?? "",
        ownerDisplayName: auth?.profile?.displayName ?? "",
        forkedFrom: {
          sourceSessionId: lineage.sourceSessionId,
          rootSessionId,
          forkedAt: lineage.forkedAt,
        },
      } as unknown as RemoteTeammateSessionMetadata,
    };
    return [...rootFamily, selfMember];
  }, [
    target,
    overrideEvents,
    remoteEntries,
    authIdentityKey,
    anchorBareSessionId,
    currentSession,
    auth?.userId,
    auth?.profile?.displayName,
  ]);
  const plane = useConversationPlaneEvents(target);
  const timelineFamily = useMemo(
    () =>
      legacyConversationFamilyForTimeline(
        family,
        anchorBareSessionId,
        plane.events,
        plane.historyStartedAt
      ),
    [anchorBareSessionId, family, plane.events, plane.historyStartedAt]
  );

  useMarkDiscussionSeen(sessionId, comments, family);

  const memberTaps = useMemo(() => {
    if (!timelineFamily || !target) return [];
    const taps: { bareSessionId: string; localSessionId: string }[] = [];
    for (const member of timelineFamily) {
      if (member.bareSessionId === anchorBareSessionId) continue;
      const local =
        sessions.find(
          (session) => session.session_id === member.bareSessionId
        ) ??
        findImportedSession(
          sessions,
          target.orgId,
          member.bareSessionId,
          auth?.supabaseUrl
        );
      if (local) {
        taps.push({
          bareSessionId: member.bareSessionId,
          localSessionId: local.session_id,
        });
      }
    }
    return taps;
  }, [
    timelineFamily,
    target,
    sessions,
    auth?.supabaseUrl,
    anchorBareSessionId,
  ]);

  const loadedBareSessionIds = useMemo(
    () => new Set(memberTaps.map((tap) => tap.bareSessionId)),
    [memberTaps]
  );
  useEnsureFamilyLoaded(
    timelineFamily,
    loadedBareSessionIds,
    anchorBareSessionId
  );

  const [eventsByBareId, setEventsByBareId] = useState<
    ReadonlyMap<string, readonly SessionEvent[]>
  >(() => new Map());
  const handleMemberEvents = useCallback(
    (bareSessionId: string, events: SessionEvent[]) => {
      setEventsByBareId((previous) => {
        if (previous.get(bareSessionId) === events) return previous;
        const next = new Map(previous);
        next.set(bareSessionId, events);
        return next;
      });
    },
    []
  );
  const handleMemberUnmount = useCallback((bareSessionId: string) => {
    setEventsByBareId((previous) => {
      if (!previous.has(bareSessionId)) return previous;
      const next = new Map(previous);
      next.delete(bareSessionId);
      return next;
    });
  }, []);
  const viewer = resolveConversationViewerState(
    auth?.userId ?? comments?.viewerUserId ?? null,
    true
  );

  // Live overlay for THIS device's in-flight member turns: the runner is a
  // local session, so its thinking / tool / worked-for events stream in real
  // time — tap and merge them until the plane carries the turn's terminal
  // tail, so the sender sees the agent working instead of a dead wait.
  const planeRootId = target?.sessionId ?? null;
  const runnerRegistryKey = useMemo(() => {
    if (!auth || !authIdentityKey || !target || !planeRootId) return null;
    return conversationRootKey({
      authority: "org2-cloud",
      authorityScope: [
        normalizeSourceEndpointUrl(auth.supabaseUrl),
        target.orgId,
      ],
      conversationId: planeRootId,
    });
  }, [auth, authIdentityKey, planeRootId, target]);
  const localRoot = useMemo<ConversationRootLocator | null>(() => {
    if (target || overrideEvents) return null;
    const imported = conversationSourceFromImportedHistory({
      sessionId,
      session: currentSession,
    })?.root;
    const root =
      imported ??
      (currentSession ? conversationRootForSession(currentSession) : null);
    return root && root.conversationId === sessionId ? root : null;
  }, [currentSession, overrideEvents, sessionId, target]);
  const localRootKey = localRoot ? conversationRootKey(localRoot) : null;
  const localRootRef = useRef(localRoot);
  useEffect(() => {
    localRootRef.current = localRoot;
  }, [localRoot]);
  const scopedActiveDeliveriesAtom = useMemo(
    () =>
      conversationActiveDeliveriesAtom({
        cloudRootKey: runnerRegistryKey,
        cloudIdentityKey: authIdentityKey,
        localRootKey,
      }),
    [authIdentityKey, localRootKey, runnerRegistryKey]
  );
  const activeDeliveries = useAtomValue(scopedActiveDeliveriesAtom);
  const landedTurnIds = useMemo(
    () => collectLandedTurnIds(plane.events),
    [plane.events]
  );
  const activeRunners = useMemo(() => {
    return selectConversationActiveRunners(activeDeliveries, {
      cloudRootKey: runnerRegistryKey,
      cloudIdentityKey: authIdentityKey,
      localRootKey,
      landedTurnIds,
    });
  }, [
    activeDeliveries,
    authIdentityKey,
    landedTurnIds,
    localRootKey,
    runnerRegistryKey,
  ]);
  const activeRunnerIds = useMemo(
    () => new Set(activeRunners.map((runner) => runner.runnerSessionId)),
    [activeRunners]
  );
  // The in-flight runner drives the chat footer's running/typing indicator
  // so a member's long turn shows "Thinking…" instead of a frozen screen.
  const activeRunnerSessionId =
    activeRunners.length > 0
      ? activeRunners[activeRunners.length - 1].runnerSessionId
      : null;
  const localRootDeliveryCount = useMemo(
    () =>
      localRootKey
        ? activeDeliveries.filter(
            (delivery) =>
              conversationRootKey(delivery.conversationDispatch.root) ===
              localRootKey
          ).length
        : 0,
    [activeDeliveries, localRootKey]
  );
  const [loadedLocalExecution, setLoadedLocalExecution] =
    useState<LocalExecutionHydrationSnapshot | null>(null);
  const localHydrationCoordinatorRef =
    useRef<LocalExecutionHydrationCoordinator<LocalExecutionHydrationRequest> | null>(
      null
    );
  const localHydrationTriggerRef =
    useRef<LocalExecutionHydrationTrigger | null>(null);
  useEffect(() => {
    const coordinator = createLocalExecutionHydrationCoordinator<
      LocalExecutionHydrationRequest,
      LocalExecutionHydrationSnapshot
    >(
      hydrateLocalExecutionSnapshot,
      (next) => {
        setLoadedLocalExecution(next);
      },
      (error, request) => {
        log.warn("local execution hydration could not load children", {
          sessionId: request.root.conversationId,
          localRootKey: request.rootKey,
          error,
        });
      }
    );
    localHydrationCoordinatorRef.current = coordinator;
    coordinator.activate();
    return () => {
      coordinator.deactivate();
      if (localHydrationCoordinatorRef.current === coordinator) {
        localHydrationCoordinatorRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    const nextTrigger = {
      rootKey: localRootKey,
      activeDeliveryCount: localRootDeliveryCount,
    };
    const shouldHydrate = shouldHydrateLocalExecutionSnapshot(
      localHydrationTriggerRef.current,
      nextTrigger
    );
    localHydrationTriggerRef.current = nextTrigger;
    const coordinator = localHydrationCoordinatorRef.current;
    if (!coordinator) return;
    const currentRoot = localRootRef.current;
    if (!currentRoot || !localRootKey) {
      coordinator.invalidate();
      return;
    }
    if (!shouldHydrate) return;
    coordinator.request({
      root: currentRoot,
      rootKey: localRootKey,
    });
  }, [localRootDeliveryCount, localRootKey]);
  const localSnapshot =
    localRootKey && loadedLocalExecution?.rootKey === localRootKey
      ? loadedLocalExecution.snapshot
      : null;
  const authoritativeLocalRootEvents = localSnapshot?.rootEvents ?? null;
  const localExecutionSegments: readonly LocalExecutionSegment[] =
    localSnapshot?.segments ?? EMPTY_LOCAL_EXECUTION_SEGMENTS;
  const localCanonicalExecutionTimeline =
    localSnapshot?.events ?? EMPTY_SESSION_EVENTS;
  const localTails = useMemo(() => {
    if (!localRootKey || !authoritativeLocalRootEvents) return [];
    return projectVisibleLocalExecutionTail(
      authoritativeLocalRootEvents,
      localExecutionSegments,
      sessionId
    );
  }, [
    authoritativeLocalRootEvents,
    localExecutionSegments,
    localRootKey,
    sessionId,
  ]);
  const [runnerOverlayById, setRunnerOverlayById] = useState<
    ReadonlyMap<string, readonly SessionEvent[]>
  >(() => new Map());
  const handleRunnerEvents = useCallback(
    (runnerSessionId: string, events: SessionEvent[]) => {
      const runner = activeRunners.find(
        (candidate) => candidate.runnerSessionId === runnerSessionId
      );
      if (!runner) return;
      const overlay = buildConversationRunnerOverlay(
        runner,
        events,
        sessionId,
        localCanonicalExecutionTimeline
      );
      setRunnerOverlayById((previous) => {
        if (
          conversationRunnerOverlaysEqual(
            previous.get(runnerSessionId),
            overlay
          )
        ) {
          return previous;
        }
        const next = new Map(
          [...previous].filter(([id]) => activeRunnerIds.has(id))
        );
        // Keep only the current-turn projection. Holding the full native
        // transcript here would pin a large imported/reused Session after the
        // EventStore subscription is gone.
        next.set(runnerSessionId, overlay);
        return next;
      });
    },
    [activeRunnerIds, activeRunners, localCanonicalExecutionTimeline, sessionId]
  );
  const handleRunnerUnmount = useCallback((runnerSessionId: string) => {
    setRunnerOverlayById((previous) => {
      if (!previous.has(runnerSessionId)) return previous;
      const next = new Map(previous);
      next.delete(runnerSessionId);
      return next;
    });
  }, []);

  const value = useMemo((): SessionEvent[] | undefined => {
    if (overrideEvents) return overrideEvents;
    const timeline = assembleCanonicalConversationTimeline({
      family: timelineFamily,
      anchorBareSessionId,
      anchorEvents: chatEvents,
      eventsByBareSessionId: eventsByBareId,
      planeEvents: plane.events,
      planeHistoryStartedAt: plane.historyStartedAt,
      comments: discussionComments,
      streamSessionId: sessionId,
      viewer,
      ...(toSourceEventId ? { toSourceEventId } : {}),
    });
    // The only UI-only addition is the sender's live runner overlay.
    const synthetic: SessionEvent[] = [];
    // Live runner overlay (sender-local, pre-tail): show the agent working.
    // The canonical optimistic row already owns the visible user message, so
    // the overlay contributes only provider output. Its ids are namespaced and
    // the whole overlay vanishes once the turnId lands on the plane above.
    for (const runner of activeRunners) {
      const overlay = runnerOverlayById.get(runner.runnerSessionId);
      if (overlay?.length) synthetic.push(...overlay);
    }
    if (localTails.length > 0) {
      return mergeConversationEvents(
        suppressLandedQueuedUserRows(timeline, localTails),
        [
          ...synthetic,
          ...suppressLandedRowsOfFailedQueuedTurns(timeline, localTails),
        ]
      );
    }
    if (synthetic.length === 0) {
      return timelineFamily ||
        plane.events.length > 0 ||
        discussionComments.length > 0
        ? timeline
        : undefined;
    }
    return mergeConversationEvents(timeline, synthetic);
  }, [
    localTails,
    overrideEvents,
    timelineFamily,
    anchorBareSessionId,
    chatEvents,
    eventsByBareId,
    sessionId,
    viewer,
    discussionComments,
    toSourceEventId,
    plane.events,
    plane.historyStartedAt,
    activeRunners,
    runnerOverlayById,
  ]);
  return (
    <>
      {memberTaps.map((tap) => (
        <MemberEventsTap
          key={tap.localSessionId}
          bareSessionId={tap.bareSessionId}
          localSessionId={tap.localSessionId}
          onEvents={handleMemberEvents}
          onUnmount={handleMemberUnmount}
        />
      ))}
      {activeRunners.map((runner) => (
        <MemberEventsTap
          key={`runner-${runner.runnerSessionId}`}
          bareSessionId={runner.runnerSessionId}
          localSessionId={runner.runnerSessionId}
          onEvents={handleRunnerEvents}
          onUnmount={handleRunnerUnmount}
        />
      ))}
      <ChatHistoryOverrideContext.Provider value={value}>
        {children(activeRunnerSessionId)}
      </ChatHistoryOverrideContext.Provider>
    </>
  );
}
