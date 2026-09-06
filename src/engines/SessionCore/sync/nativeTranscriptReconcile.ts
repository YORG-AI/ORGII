/**
 * Single post-turn owner for provider-native transcript reconciliation.
 *
 * Native CLI adapters stream an ephemeral EventStore projection while the
 * provider writes its own transcript. Once a turn is terminal, every caller
 * (the visible Session sync and background canonical continuation) joins the
 * same per-Session promise. This module alone reads the settled native file,
 * preserves a durable interrupted suffix, replaces EventStore, and closes
 * streaming. Conversation code may inspect the returned events, but must not
 * race this owner with a second replace/merge pipeline.
 */
import { rpc } from "@src/api/tauri/rpc";
import {
  mergeInterruptedConversationProjection,
  nativeConversationItemsAreProviderPortablePrefix,
  nativeSourceEventId,
  projectNativeConversationItems,
  sourceEventIdOfNativeItem,
} from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  closeObservedCliTerminalEvents,
  isCliTerminalStatus,
} from "@src/engines/SessionCore/sync/adapters/cli/cliLifecycle";

import { loadAuthoritativeSessionEvents } from "./authoritativeSessionEvents";
import { mergeFailedUserDeliveryProjection } from "./sessionSyncUtils";

const MISMATCH_RECOVERY_DELAYS_MS = [250, 750] as const;

async function hasDurableNativeTranscript(sessionId: string): Promise<boolean> {
  const session = await rpc.cli.status({ sessionId });
  return session?.transcriptSource === "native";
}

export interface NativeTranscriptReconcileOptions {
  /** Preserve provider-portable output that survived an interrupted flush. */
  preserveInterruptedSuffix?: boolean;
}

interface ReconcileJob {
  preserveInterruptedSuffix: boolean;
  promise: Promise<SessionEvent[]>;
}

const reconcileJobs = new Map<string, ReconcileJob>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeProjection(
  nativeEvents: readonly SessionEvent[],
  projectedEvents: readonly SessionEvent[],
  preserveInterruptedSuffix: boolean
): SessionEvent[] {
  const interrupted =
    preserveInterruptedSuffix && projectedEvents.length > 0
      ? mergeInterruptedConversationProjection(nativeEvents, projectedEvents)
      : [...nativeEvents];
  return mergeFailedUserDeliveryProjection(
    preserveAcceptedTurnIdentity(interrupted, projectedEvents),
    projectedEvents
  );
}

/**
 * Native files do not know ORG2's accepted intent. Transfer only that metadata
 * across the ordinary projection replacement, after proving the entire
 * pre-turn history and accepted user message still match in order. Matching
 * one prompt by text is insufficient: consecutive identical prompts are valid.
 * Provider content remains authoritative; no streamed body is retained here.
 */
function preserveAcceptedTurnIdentity(
  nativeEvents: readonly SessionEvent[],
  projectedEvents: readonly SessionEvent[]
): SessionEvent[] {
  // Identity belongs to the full audit log, not the compacted effective model
  // context. Ignore compaction control rows only for this comparison so a
  // compact in the current turn cannot erase its accepted user boundary.
  const fullLog = (events: readonly SessionEvent[]) =>
    events.filter(
      (event) =>
        event.actionType !== "context_compacted" &&
        event.functionName !== "context_compacted"
    );
  const projectedItems = projectNativeConversationItems(
    fullLog(projectedEvents)
  );
  let anchor = -1;
  for (let index = projectedItems.length - 1; index >= 0; index -= 1) {
    const item = projectedItems[index];
    if (item.kind === "message" && item.role === "user" && item.turnId) {
      anchor = index;
      break;
    }
  }
  if (anchor < 0) return nativeEvents as SessionEvent[];
  const accepted = projectedItems[anchor];
  if (accepted.kind !== "message" || !accepted.turnId) {
    return nativeEvents as SessionEvent[];
  }
  const nativeItems = projectNativeConversationItems(fullLog(nativeEvents));
  if (
    !nativeConversationItemsAreProviderPortablePrefix(
      projectedItems.slice(0, anchor + 1),
      nativeItems
    )
  ) {
    return nativeEvents as SessionEvent[];
  }
  const acceptedSourceId = sourceEventIdOfNativeItem(nativeItems[anchor]);
  const userIndex = nativeEvents.findIndex(
    (event) => nativeSourceEventId(event) === acceptedSourceId
  );
  if (
    userIndex < 0 ||
    (nativeEvents[userIndex].result?.turnIntentId &&
      nativeEvents[userIndex].result?.turnIntentId !== accepted.turnId)
  ) {
    return nativeEvents as SessionEvent[];
  }
  const nextUser = nativeEvents.findIndex(
    (event, index) => index > userIndex && event.source === "user"
  );
  return nativeEvents.map((event, index) =>
    index >= userIndex &&
    (nextUser < 0 || index < nextUser) &&
    !event.result?.turnIntentId
      ? { ...event, result: { ...event.result, turnIntentId: accepted.turnId } }
      : event
  );
}

async function publishNativeProjection(
  sessionId: string,
  nativeEvents: readonly SessionEvent[],
  projectedEvents: readonly SessionEvent[],
  preserveInterruptedSuffix: boolean
): Promise<SessionEvent[]> {
  const events = mergeProjection(
    nativeEvents,
    projectedEvents,
    preserveInterruptedSuffix
  );
  // An authoritative empty transcript is still an authoritative replacement.
  // Skipping the write here would leave stale streamed/projected rows visible
  // after the provider history was cleared or reset.
  await eventStoreProxy.set(events, sessionId);
  return events;
}

async function runReconcile(
  sessionId: string,
  job: ReconcileJob
): Promise<SessionEvent[]> {
  // `code_sessions.transcript_source` is the authority. Hidden/background
  // continuations may never mount a CLI adapter, so an in-memory UI registry
  // cannot decide whether provider-native reconciliation is required.
  const session = await rpc.cli.status({ sessionId });
  if (session?.transcriptSource !== "native") {
    return loadAuthoritativeSessionEvents(sessionId).then(
      ({ events }) => events
    );
  }
  if (job.preserveInterruptedSuffix && isCliTerminalStatus(session.status)) {
    // The durable turn-intent terminal can wake a background continuation
    // before the mounted CLI handler finishes closing its visible partial
    // rows. Join the same EventStore barrier here so reconciliation never
    // snapshots a still-delta assistant message or a still-running tool.
    await closeObservedCliTerminalEvents(sessionId, session.status);
  }
  // The backend converges the provider transcript before broadcasting the
  // terminal lifecycle. One authoritative read is therefore the normal path.
  // Check the mutable preserve flag after every await so a foreground caller
  // can still upgrade an in-flight background job without a settle delay. A
  // normal completed turn never pays for a second full-history cache read.
  const nativeEvents = await loadAuthoritativeSessionEvents(sessionId).then(
    ({ events }) => events
  );
  let preserveApplied = false;
  const publishCurrentProjection = async (): Promise<SessionEvent[]> => {
    // Accepted intent metadata and failed delivery rows belong to ORG2 even
    // on success. Read them before replacement; a failed read must not erase
    // the retry owner or make current output disappear while Cloud publishes.
    const projectedEvents = await eventStoreProxy.getPersistedEvents(sessionId);
    preserveApplied = job.preserveInterruptedSuffix;
    return await publishNativeProjection(
      sessionId,
      nativeEvents,
      projectedEvents,
      job.preserveInterruptedSuffix
    );
  };

  let published = await publishCurrentProjection();
  if (job.preserveInterruptedSuffix && !preserveApplied) {
    published = await publishCurrentProjection();
  }

  await eventStoreProxy.setStreaming(false, sessionId);
  if (job.preserveInterruptedSuffix && !preserveApplied) {
    published = await publishCurrentProjection();
  }
  return published;
}

/**
 * Exceptional recovery after the caller has proved that the authoritative
 * read is missing its expected semantic prefix/user anchor. Normal terminal
 * reconciliation never enters this bounded retry path.
 */
export async function recoverNativeTranscriptAfterMismatch(
  sessionId: string,
  initialEvents: SessionEvent[],
  isRecovered: (events: readonly SessionEvent[]) => boolean,
  options: NativeTranscriptReconcileOptions = {}
): Promise<SessionEvent[]> {
  let events = initialEvents;
  if (isRecovered(events)) return events;

  for (const retryDelay of MISMATCH_RECOVERY_DELAYS_MS) {
    await delay(retryDelay);
    events = await reconcileNativeTranscript(sessionId, options);
    if (isRecovered(events)) break;
  }
  return events;
}

/** Await the unique native reconcile for a Session. */
export function reconcileNativeTranscript(
  sessionId: string,
  options: NativeTranscriptReconcileOptions = {}
): Promise<SessionEvent[]> {
  const existing = reconcileJobs.get(sessionId);
  if (existing) {
    if (options.preserveInterruptedSuffix) {
      existing.preserveInterruptedSuffix = true;
    }
    return existing.promise;
  }

  const job: ReconcileJob = {
    preserveInterruptedSuffix: Boolean(options.preserveInterruptedSuffix),
    promise: Promise.resolve([]),
  };
  job.promise = runReconcile(sessionId, job).finally(() => {
    if (reconcileJobs.get(sessionId) === job) {
      reconcileJobs.delete(sessionId);
    }
  });
  reconcileJobs.set(sessionId, job);
  return job.promise;
}

/** Fire-and-forget bridge used by the ordinary visible Session lifecycle. */
export function scheduleNativeTranscriptReconcile(
  sessionId: string,
  options: NativeTranscriptReconcileOptions = {}
): void {
  // This fire-and-forget path is invoked for legacy chunk-backed CLI sessions
  // too. Check the durable row before entering reconciliation so their
  // terminal event does not trigger a needless full-history read. The actual
  // reconcile rechecks the same authority and coalesces concurrent callers.
  void hasDurableNativeTranscript(sessionId)
    .then((isNative) =>
      isNative ? reconcileNativeTranscript(sessionId, options) : undefined
    )
    .catch(() => {
      // The ephemeral projection stays visible and a later open/recovery can
      // retry from the provider transcript. Scheduling must never throw into a
      // status event handler.
    });
}
