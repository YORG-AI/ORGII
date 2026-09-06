import type { Store } from "jotai/vanilla/store";

import { cloudDeviceIdentity } from "@src/api/tauri/cloudDevice";
import { loadCanonicalConversationEvents } from "@src/engines/SessionCore/conversations/canonicalConversationEvents";
import type { ConversationRootLocator } from "@src/engines/SessionCore/conversations/conversationTypes";
import {
  conversationTurnIdOf,
  localConversationRootForSession,
} from "@src/engines/SessionCore/conversations/localConversationContinuation";
import type {
  QueuedConversationDispatchCallbacks,
  QueuedConversationExecutionMessage,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import {
  QueuedConversationBlockedError,
  QueuedConversationRecoveryPendingError,
  QueuedConversationTurnClosedError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { refreshOrg2CloudAuthForAction } from "@src/features/Org2Cloud/org2CloudAuthAction";
import {
  type Org2CloudAuthState,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { buildCloudSessionFetchClient } from "@src/features/Org2Cloud/org2CloudBackendAdapter";
import { getCloudCapabilitiesConfirmed } from "@src/features/Org2Cloud/org2CloudCapabilities";
import { listSessionComments } from "@src/features/Org2Cloud/org2CloudCommentsClient";
import {
  Org2CloudConversationError,
  conversationEventsForPush,
  pushConversationEventsChunked,
} from "@src/features/Org2Cloud/org2CloudConversationEventsClient";
import {
  admitCloudConversationTurn,
  claimCloudConversationTurn,
  finishCloudConversationTurn,
  markCloudConversationTurnAccepted,
  renewCloudConversationTurn,
} from "@src/features/Org2Cloud/org2CloudConversationTurnClient";
import { isRetryableCloudRequestError } from "@src/features/Org2Cloud/org2CloudFetchRetry";
import { endpointForOrigin } from "@src/features/Org2Cloud/org2CloudOrgEndpointRouter";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import {
  findImportedSession,
  normalizeSourceEndpointUrl,
} from "@src/features/TeamCollaboration/engine/collabImportIdentity";
import { importRemoteSession } from "@src/features/TeamCollaboration/engine/collabSessionImport";
import { createLogger } from "@src/hooks/logger";
import type { Session } from "@src/store/session";
import { sessionsAtom } from "@src/store/session";

import {
  CanonicalConversationFamilyUnavailableError,
  loadCanonicalConversationTimeline,
} from "./canonicalConversationTimeline";
import {
  type ConversationFamilyMember,
  resolveConversationFamily,
} from "./continuationEvents";
import {
  bumpConversationPlaneSignal,
  conversationPlaneAtom,
  conversationPlaneKey,
  conversationPlaneSignalAtom,
  loadCompleteConversationPlaneEvents,
  refreshConversationPlaneEntry,
} from "./conversationPlaneAtom";
import {
  buildPushedUserEvent,
  closeConversationTurnWithFailure,
  runConversationTurn,
} from "./conversationTurnRunner";

const log = createLogger("CloudConversationQueueAdapter");
const CLOUD_TURN_LEASE_SECONDS = 30;
const CLOUD_TURN_RENEW_INTERVAL_MS = 10_000;

interface CloudTurnLeaseRenewal {
  stop: () => Promise<void>;
}

/**
 * One in-flight turn owns one recursive renewal timer. This is lease
 * maintenance for the existing queue owner, not a second dispatcher/watcher.
 */
function startCloudTurnLeaseRenewal(
  renew: () => Promise<void>
): CloudTurnLeaseRenewal {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = renew()
        .catch((error) => {
          log.warn("Cloud conversation turn lease renewal failed", error);
        })
        .finally(() => {
          inFlight = undefined;
          schedule();
        });
    }, CLOUD_TURN_RENEW_INTERVAL_MS);
  };
  schedule();
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
    },
  };
}

function sessionById(store: Store, sessionId: string): Session | undefined {
  return store
    .get(sessionsAtom)
    .find((candidate) => candidate.session_id === sessionId);
}

function cloudLocator(root: ConversationRootLocator): {
  orgId: string;
  rootSessionId: string;
  sourceEndpointUrl?: string;
} {
  if (
    root.authority !== "org2-cloud" ||
    (root.authorityScope.length !== 1 && root.authorityScope.length !== 2)
  ) {
    throw new Error("invalid Cloud conversation identity");
  }
  const [first, second] = root.authorityScope;
  const orgId = second ?? first;
  if (!orgId) throw new Error("invalid Cloud conversation identity");
  return {
    orgId,
    rootSessionId: root.conversationId,
    ...(second ? { sourceEndpointUrl: first } : {}),
  };
}

/** Cloud authority adapter for the application's existing durable queue. */
export async function dispatchQueuedCloudConversation(
  store: Store,
  message: QueuedConversationExecutionMessage,
  root: ConversationRootLocator,
  callbacks: QueuedConversationDispatchCallbacks
): Promise<void> {
  const descriptor = message.conversationDispatch;
  if (!descriptor) throw new Error("canonical conversation target is missing");
  const { orgId, rootSessionId, sourceEndpointUrl } = cloudLocator(root);

  const expectedIdentityKey = descriptor.dispatchIdentityKey;
  if (!expectedIdentityKey) {
    throw new QueuedConversationBlockedError(
      "This restored Cloud turn predates sender binding; edit and send it again under the current account"
    );
  }
  const requireBoundAuth = (): Org2CloudAuthState => {
    const current = store.get(org2CloudAuthAtom);
    if (!current) {
      throw new QueuedConversationBlockedError("cloud sign-in required");
    }
    if (org2CloudAuthIdentityKey(current) !== expectedIdentityKey) {
      throw new QueuedConversationBlockedError(
        "This queued turn belongs to a different Cloud account; switch back to its author account to send it"
      );
    }
    if (
      sourceEndpointUrl &&
      normalizeSourceEndpointUrl(current.supabaseUrl) !== sourceEndpointUrl
    ) {
      throw new QueuedConversationBlockedError(
        "This queued turn belongs to a different Cloud deployment"
      );
    }
    return current;
  };
  const refreshBoundAuth = async (): Promise<Org2CloudAuthState> => {
    const current = requireBoundAuth();
    const result = await refreshOrg2CloudAuthForAction(current, (update) =>
      store.set(org2CloudAuthAtom, update)
    );
    if (result.status === "unavailable") {
      throw new QueuedConversationRecoveryPendingError(
        "cloud auth refresh is temporarily unavailable"
      );
    }
    if (result.status !== "ready") {
      throw new QueuedConversationBlockedError(
        result.status === "expired"
          ? "cloud sign-in expired"
          : "cloud account changed during delivery"
      );
    }
    const fresh = result.auth;
    if (org2CloudAuthIdentityKey(fresh) !== expectedIdentityKey) {
      throw new QueuedConversationBlockedError(
        "cloud account changed during delivery"
      );
    }
    requireBoundAuth();
    return fresh;
  };

  const auth = await refreshBoundAuth();
  const authIdentityKey = expectedIdentityKey;
  const endpoint = {
    supabaseUrl: auth.supabaseUrl,
    anonKey: auth.supabaseAnonKey,
  };
  const capabilityProbe = await getCloudCapabilitiesConfirmed(
    auth.accessToken,
    endpoint
  );
  if (
    !capabilityProbe.confirmed ||
    !capabilityProbe.capabilities.conversationEventsIdempotency
  ) {
    if (!capabilityProbe.confirmed) {
      throw new QueuedConversationRecoveryPendingError(
        "Cloud conversation capability probe is temporarily unavailable"
      );
    }
    throw new QueuedConversationBlockedError(
      "Cloud conversation idempotency is unavailable; refusing an unsafe retry"
    );
  }
  const coordinationEnabled =
    capabilityProbe.capabilities.conversationTurnCoordination === true;

  // Build the canonical user payload once. It is admitted to the shared plane
  // before the local provider turn starts; retries reuse the stable turn id.
  const userEvents = await conversationEventsForPush(
    buildPushedUserEvent(
      message.displayContent,
      message.content,
      message.imageDataUrls,
      new Date().toISOString(),
      message.turnIntentId
    )
  );
  if (
    coordinationEnabled &&
    (userEvents.length !== 1 || userEvents[0]?.source !== "user")
  ) {
    // 0028 atomically admits exactly one Agent-directed user event. The
    // existing large-event codec expands an oversized event into system
    // chunks, which cannot be admitted without splitting publication from
    // FIFO ownership. Fail closed rather than bypass cross-device ordering.
    throw new QueuedConversationBlockedError(
      "This message is too large for coordinated Cloud execution"
    );
  }
  requireBoundAuth();
  let userEventPublished = false;
  let coordinationDeviceId: string | undefined;
  let coordinationClaimed = false;
  let coordinationAlreadyTerminal = false;
  let coordinationAccepted = false;
  let leaseRenewal: CloudTurnLeaseRenewal | undefined;
  const stopLeaseRenewal = async () => {
    const current = leaseRenewal;
    leaseRenewal = undefined;
    await current?.stop();
  };
  const coordinationIdentity = () => {
    if (!coordinationDeviceId) {
      throw new Error("Cloud conversation coordination has no device owner");
    }
    return {
      orgId,
      rootSessionId,
      turnId: message.turnIntentId,
      deviceId: coordinationDeviceId,
    };
  };
  const markCoordinationAccepted = async () => {
    if (!coordinationEnabled || coordinationAccepted) return;
    try {
      const fresh = await refreshBoundAuth();
      await markCloudConversationTurnAccepted(
        fresh.accessToken,
        {
          ...coordinationIdentity(),
          leaseSeconds: CLOUD_TURN_LEASE_SECONDS,
        },
        {
          supabaseUrl: fresh.supabaseUrl,
          anonKey: fresh.supabaseAnonKey,
        }
      );
      coordinationAccepted = true;
      requireBoundAuth();
    } catch (error) {
      if (isRetryableCloudRequestError(error)) {
        throw new QueuedConversationRecoveryPendingError(
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
  };
  const finishCoordination = async (
    status: "completed" | "failed" | "cancelled"
  ) => {
    if (!coordinationEnabled || !coordinationClaimed) return;
    try {
      const fresh = await refreshBoundAuth();
      await finishCloudConversationTurn(
        fresh.accessToken,
        { ...coordinationIdentity(), status },
        {
          supabaseUrl: fresh.supabaseUrl,
          anonKey: fresh.supabaseAnonKey,
        }
      );
      requireBoundAuth();
    } catch (error) {
      // Provider/tail completion is already durable locally and possibly in
      // Cloud. Keep this same queue owner until the idempotent finish receipt
      // succeeds; never turn a bookkeeping failure into another provider run.
      throw new QueuedConversationRecoveryPendingError(
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  const publishTail = async (turnId: string, events: SessionEvent[]) => {
    const fresh = await refreshBoundAuth();
    const freshEndpoint = {
      supabaseUrl: fresh.supabaseUrl,
      anonKey: fresh.supabaseAnonKey,
    };
    await pushConversationEventsChunked(
      fresh.accessToken,
      {
        orgId,
        rootSessionId,
        turnId,
        events,
      },
      freshEndpoint
    );
    requireBoundAuth();
    bumpConversationPlaneSignal(
      (update) => store.set(conversationPlaneSignalAtom, update),
      orgId
    );
  };

  const loadTimeline = async (): Promise<{
    sourceSession: Session | undefined;
    sessions: Session[];
    timeline: SessionEvent[];
  }> => {
    const key = conversationPlaneKey({
      authIdentityKey,
      orgId,
      rootSessionId,
    });
    const plane = await refreshConversationPlaneEntry({
      store,
      auth,
      orgId,
      rootSessionId,
      getEntry: () => store.get(conversationPlaneAtom)[key],
      setEntries: (update) => store.set(conversationPlaneAtom, update),
      setAuth: (update) => store.set(org2CloudAuthAtom, update),
      invalidationKey: `signal:${
        store.get(conversationPlaneSignalAtom)[orgId] ?? 0
      }`,
    });
    if (plane.state !== "ready") {
      throw new Org2CloudConversationError(
        "ORG2_VALIDATION: canonical conversation plane is unavailable"
      );
    }
    // The plane loader may refresh and commit a newer access token. Every
    // subsequent read in this attempt must use that same current auth snapshot
    // rather than the token captured before the plane refresh.
    const currentAuth = requireBoundAuth();
    const currentEndpoint = {
      supabaseUrl: currentAuth.supabaseUrl,
      anonKey: currentAuth.supabaseAnonKey,
    };
    const planeEvents = plane.hasEarlierEvents
      ? await loadCompleteConversationPlaneEvents(
          currentAuth.accessToken,
          { orgId, rootSessionId },
          currentEndpoint
        )
      : plane.events;
    requireBoundAuth();

    const sourceSession = sessionById(store, message.sessionId);
    const sessions = store.get(sessionsAtom);
    const remoteEntry = remoteSessionsEntryForIdentity(
      store.get(org2CloudRemoteSessionsAtom)[orgId],
      authIdentityKey
    );
    if (!remoteEntry || remoteEntry.state !== "ready") {
      throw new QueuedConversationRecoveryPendingError(
        "Cloud conversation family metadata is not ready"
      );
    }
    const family = resolveConversationFamily(remoteEntry.rows, rootSessionId);
    const rootRow = remoteEntry.rows.find(
      (row) => row.sourceSessionId === rootSessionId
    );
    if (!rootRow) {
      // A replay viewer may simply be ahead of its listing; the owner of a
      // local session is not. Its root row left the listing for good
      // (retention expiry or retract), so the Cloud plane can never admit
      // this turn. Fail the send visibly instead of retrying forever; the
      // retry re-resolves the root through the binding, which continues the
      // conversation locally.
      if (sourceSession && !sourceSession.importedFrom) {
        throw new QueuedConversationBlockedError(
          "This shared session is no longer available in Cloud; retry to continue it locally"
        );
      }
      throw new QueuedConversationRecoveryPendingError(
        "Cloud conversation root metadata is unavailable"
      );
    }
    const listing = await listSessionComments(
      currentAuth.accessToken,
      orgId,
      rootSessionId,
      { endpoint: currentEndpoint }
    );
    requireBoundAuth();
    const fetchClient = buildCloudSessionFetchClient(currentAuth.accessToken, {
      ...endpointForOrigin(currentAuth.supabaseUrl),
      anonKey: currentAuth.supabaseAnonKey,
    });
    const loadMemberEvents = async (
      bareSessionId: string,
      member: ConversationFamilyMember | null
    ): Promise<readonly SessionEvent[] | null> => {
      const row = member?.row ?? rootRow;
      const local =
        sessions.find((session) => session.session_id === bareSessionId) ??
        findImportedSession(
          sessions,
          orgId,
          bareSessionId,
          currentAuth.supabaseUrl
        );
      // External native histories are intentionally absent from sessionsAtom
      // but remain readable by their canonical id.
      let localSessionId =
        local?.session_id ??
        (message.sessionId === bareSessionId ? message.sessionId : undefined);
      if (!localSessionId) {
        if (
          row.deletedAt ||
          row.eventsEpoch === undefined ||
          row.eventsCount === undefined ||
          row.eventsCount === 0
        ) {
          return [];
        }
        const imported = await importRemoteSession({
          client: fetchClient,
          orgId,
          remoteSession: row,
          sourceEndpointUrl: currentAuth.supabaseUrl,
        });
        localSessionId = imported?.localSessionId;
      }
      if (!localSessionId) return null;
      return (await loadCanonicalConversationEvents(localSessionId)).events;
    };
    try {
      return {
        sourceSession,
        sessions,
        timeline: await loadCanonicalConversationTimeline({
          family,
          anchorBareSessionId: rootSessionId,
          planeEvents,
          planeHistoryStartedAt: plane.historyStartedAt,
          comments: listing.comments,
          streamSessionId: message.sessionId,
          viewer: { status: "known", userId: currentAuth.userId },
          loadMemberEvents,
        }),
      };
    } catch (error) {
      if (error instanceof CanonicalConversationFamilyUnavailableError) {
        throw new QueuedConversationRecoveryPendingError(error.message);
      }
      throw error;
    }
  };
  try {
    const loaded = await loadTimeline();
    const sourceSession = loaded.sourceSession;
    const sessions = loaded.sessions;
    const executionRoot =
      sourceSession &&
      !sourceSession.importedFrom &&
      sourceSession.session_id === rootSessionId
        ? (localConversationRootForSession(
            sourceSession.session_id,
            sourceSession.cliAgentType,
            sourceSession.agentDefinitionId
          ) ?? undefined)
        : undefined;

    // A retry may already have admitted this exact user row. It is never part
    // of the provider prefix: the selected runtime receives it exactly once
    // through the ordinary dispatch path below.
    const preTurnTimeline = loaded.timeline.filter(
      (event) => conversationTurnIdOf(event) !== message.turnIntentId
    );
    // Native/App-origin history is published by the existing full-replay
    // owner before Cloud authority is admitted. This turn adapter owns only
    // the new plane user row and its provider tail; appending old local child
    // history here would create a second writer and place it at today's plane
    // sequence rather than its original transcript position.
    const timeline = preTurnTimeline;

    // Crossing into this RPC can be irreversible when its response is lost:
    // Cloud may already contain the idempotent human row. Ambiguous failures
    // keep the same turn owner; a definitive 4xx remains editable because it
    // proves that this write did not commit.
    const admissionAuth = requireBoundAuth();
    if (coordinationEnabled) {
      const device = await cloudDeviceIdentity();
      coordinationDeviceId = device.deviceId;
      await admitCloudConversationTurn(
        admissionAuth.accessToken,
        {
          orgId,
          rootSessionId,
          turnId: message.turnIntentId,
          event: userEvents[0]!,
        },
        {
          supabaseUrl: admissionAuth.supabaseUrl,
          anonKey: admissionAuth.supabaseAnonKey,
        }
      );
      userEventPublished = true;
      requireBoundAuth();
      bumpConversationPlaneSignal(
        (update) => store.set(conversationPlaneSignalAtom, update),
        orgId
      );
      const claimAuth = await refreshBoundAuth();
      const claim = await claimCloudConversationTurn(
        claimAuth.accessToken,
        {
          ...coordinationIdentity(),
          leaseSeconds: CLOUD_TURN_LEASE_SECONDS,
        },
        {
          supabaseUrl: claimAuth.supabaseUrl,
          anonKey: claimAuth.supabaseAnonKey,
        }
      );
      requireBoundAuth();
      if (claim.outcome === "waiting") {
        throw new QueuedConversationRecoveryPendingError(
          `another Cloud turn is ahead; retry after ${claim.retryAfterMs}ms`
        );
      }
      if (claim.outcome === "terminal") {
        coordinationAlreadyTerminal = true;
        if (claim.status === "completed") return;
        throw new QueuedConversationTurnClosedError(
          `Cloud conversation turn is already ${claim.status}`
        );
      }
      coordinationClaimed = true;
      coordinationAccepted = claim.outcome === "accepted";
      leaseRenewal = startCloudTurnLeaseRenewal(async () => {
        const current = requireBoundAuth();
        await renewCloudConversationTurn(
          current.accessToken,
          {
            ...coordinationIdentity(),
            leaseSeconds: CLOUD_TURN_LEASE_SECONDS,
          },
          {
            supabaseUrl: current.supabaseUrl,
            anonKey: current.supabaseAnonKey,
          }
        );
      });
      if (message.status === "accepted" || claim.outcome === "accepted") {
        if (!message.runnerSessionId) {
          throw new QueuedConversationRecoveryPendingError(
            "accepted Cloud turn is waiting for its local runner address"
          );
        }
        await markCoordinationAccepted();
        // Cloud `accepted` means this device crossed the non-stealable FIFO
        // boundary immediately before provider dispatch. It is not itself
        // proof that the local provider accepted the turn. After a crash in
        // that narrow window, keep the durable delivery `preparing` so native
        // turn-intent recovery may either reconnect or perform the first send.
        // Only a delivery already persisted as accepted may restore that
        // irreversible local boundary here.
        if (message.status === "accepted") {
          try {
            await callbacks.onAccepted(message.runnerSessionId);
          } catch (error) {
            throw new QueuedConversationRecoveryPendingError(
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }
    } else {
      // Pre-0028 endpoints retain the exact existing idempotent publication
      // path. Capability rollout is additive and never changes old workflow.
      await pushConversationEventsChunked(
        admissionAuth.accessToken,
        {
          orgId,
          rootSessionId,
          turnId: message.turnIntentId,
          events: userEvents,
        },
        {
          supabaseUrl: admissionAuth.supabaseUrl,
          anonKey: admissionAuth.supabaseAnonKey,
        }
      );
      userEventPublished = true;
      requireBoundAuth();
      bumpConversationPlaneSignal(
        (update) => store.set(conversationPlaneSignalAtom, update),
        orgId
      );
    }

    let accepted = false;
    const accept = async (sessionId: string) => {
      if (accepted) return;
      accepted = true;
      await callbacks.onAccepted(sessionId);
    };
    const result = await runConversationTurn({
      root: executionRoot ?? root,
      conversationTitle:
        sourceSession?.name ??
        sessions.find((session) => session.session_id === rootSessionId)
          ?.name ??
        "Conversation",
      displayText: message.displayContent,
      agentContent: message.content,
      imageDataUrls: message.imageDataUrls,
      timeline,
      target: descriptor.target,
      turnIntentId: message.turnIntentId,
      ...(message.runnerSessionId
        ? {
            recovery: {
              runnerSessionId: message.runnerSessionId,
              eventStartIndex: message.runnerEventStartIndex,
              providerAccepted: message.status === "accepted",
            },
          }
        : {}),
      publishTail,
      onRunnerReady: async (runnerSessionId, turnId, eventStartIndex) => {
        void turnId;
        await callbacks.onRunnerReady?.(runnerSessionId, eventStartIndex);
      },
      onBeforeTurnDispatch: markCoordinationAccepted,
      onTurnAccepted: accept,
    });
    // Cloud publication is part of the accepted execution's completion. If it
    // failed, the same durable row reconnects to this native turn and retries
    // the idempotent push without running the provider again.
    await accept(result.runnerSessionId);
    await stopLeaseRenewal();
    await finishCoordination(result.terminalStatus);
  } catch (error) {
    if (error instanceof QueuedConversationRecoveryPendingError) {
      throw error;
    }
    if (error instanceof QueuedConversationTurnClosedError) {
      if (coordinationClaimed && !coordinationAlreadyTerminal) {
        await stopLeaseRenewal();
        await finishCoordination("failed");
      }
      throw error;
    }
    if (isRetryableCloudRequestError(error)) {
      // The response may have been lost after the idempotent write committed,
      // or a 5xx may recover. Keep exactly this owner and turn id; recovery
      // never sends a second provider request after acceptance.
      throw new QueuedConversationRecoveryPendingError(
        error instanceof Error ? error.message : String(error)
      );
    }
    if (coordinationEnabled && userEventPublished && !coordinationClaimed) {
      // Admission and FIFO ownership are one logical handoff. A definitive
      // claim rejection must retain the active execution owner; the queue's
      // ordinary blocked path demotes/removes it and would orphan this Cloud
      // FIFO head. Retry the same idempotent claim until it can be reconciled.
      throw new QueuedConversationRecoveryPendingError(
        error instanceof Error ? error.message : String(error)
      );
    }
    if (!userEventPublished) {
      // A definitive rejection before the canonical user row exists is still
      // editable. Return it to the existing visible held queue instead of
      // creating a provider turn or retrying an unchanged 4xx forever.
      throw new QueuedConversationBlockedError(
        error instanceof Error ? error.message : String(error)
      );
    }
    // The user row is durable and the failure is definitive. Close the same
    // visible turn through the shared terminal-event boundary. If that final
    // write is ambiguous it alone remains recovery-pending; a definitive 4xx
    // closes the owner and never reruns the provider.
    try {
      return await closeConversationTurnWithFailure({
        rootLabel: `org2-cloud:${rootSessionId}`,
        error,
        turnIntentId: message.turnIntentId,
        publishTail,
      });
    } catch (closeError) {
      if (
        closeError instanceof QueuedConversationTurnClosedError &&
        coordinationClaimed
      ) {
        await stopLeaseRenewal();
        await finishCoordination("failed");
      }
      throw closeError;
    }
  } finally {
    await stopLeaseRenewal();
  }
}
