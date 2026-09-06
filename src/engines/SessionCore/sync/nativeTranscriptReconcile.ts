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
import { mergeInterruptedConversationProjection } from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
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
  projectedEvents: readonly SessionEvent[]
): SessionEvent[] {
  const interrupted =
    projectedEvents.length > 0
      ? mergeInterruptedConversationProjection(nativeEvents, projectedEvents)
      : [...nativeEvents];
  return mergeFailedUserDeliveryProjection(interrupted, projectedEvents);
}

async function publishNativeProjection(
  sessionId: string,
  nativeEvents: readonly SessionEvent[],
  projectedEvents: readonly SessionEvent[]
): Promise<SessionEvent[]> {
  const events = mergeProjection(nativeEvents, projectedEvents);
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
    const projectedEvents = job.preserveInterruptedSuffix
      ? await eventStoreProxy.getPersistedEvents(sessionId).catch(() => [])
      : [];
    preserveApplied = job.preserveInterruptedSuffix;
    return await publishNativeProjection(
      sessionId,
      nativeEvents,
      projectedEvents
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
