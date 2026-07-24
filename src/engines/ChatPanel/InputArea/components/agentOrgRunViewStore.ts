import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import {
  type AgentOrgRunStatus,
  type AgentOrgRunView,
  getAgentOrgSessionRunView,
  subscribeAgentOrgStateChanges,
} from "@src/api/tauri/agent/orgTasks";

export const AGENT_ORG_RUN_VIEW_FALLBACK_MS = 60_000;
export const AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS = 50;
export const AGENT_ORG_RUN_VIEW_CACHE_RETENTION_MS = 30_000;
export const AGENT_ORG_BOOTSTRAP_JOIN_TIMEOUT_MS = 1_000;
const MAX_NON_ORG_DISCOVERY_ATTEMPTS = 1;

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentOrgRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "abandoned",
]);

export interface AgentOrgRunViewSnapshot {
  view: AgentOrgRunView | null;
  error: string | null;
}

type Subscriber = () => void;

interface RunViewEntry {
  sessionId: string;
  snapshot: AgentOrgRunViewSnapshot;
  serializedView: string | null;
  subscribers: Set<Subscriber>;
  discoveryAttempts: number;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  bootstrapWait: Promise<void> | null;
  lastAppliedRequestId: number;
  hasBeenSubscribed: boolean;
  /** Set once this cache generation is evicted; late IPC responses are ignored. */
  retired: boolean;
}

const EMPTY_SNAPSHOT: AgentOrgRunViewSnapshot = {
  view: null,
  error: null,
};

const entriesBySessionId = new Map<string, RunViewEntry>();
const inFlightByRunOrSession = new Map<string, Promise<void>>();
const latestRequestIdByRun = new Map<string, number>();
const refreshAfterInFlight = new Set<string>();
const pushDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const interventionExpiryTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
let nextRequestId = 0;
let activeSubscriberCount = 0;
let bootstrapOwner: RunViewEntry | null = null;
let pollingTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribeStateChanges: (() => void) | undefined;
let unsubscribeBackendChanges: (() => void) | undefined;
let unsubscribeCliSessionChanges: (() => void) | undefined;
let unsubscribeWebsocketConnected: (() => void) | undefined;
let visibilityListenerInstalled = false;

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || !document.hidden;
}

function runViewContainsSession(
  view: AgentOrgRunView,
  sessionId: string
): boolean {
  if (view.context.rootSessionId === sessionId) return true;
  return view.members.some(
    (member) => member.sessionRuntime?.sessionId === sessionId
  );
}

function viewForSession(
  view: AgentOrgRunView,
  sessionId: string
): AgentOrgRunView {
  const member = view.members.find(
    (candidate) => candidate.sessionRuntime?.sessionId === sessionId
  );
  const rootCoordinator =
    view.context.rootSessionId === sessionId
      ? view.members.find((candidate) => candidate.isCoordinator)
      : undefined;
  const currentMemberId = member?.memberId ?? rootCoordinator?.memberId;
  if (!currentMemberId || currentMemberId === view.currentMemberId) return view;
  return { ...view, currentMemberId };
}

function isTerminal(view: AgentOrgRunView | null): boolean {
  return view !== null && TERMINAL_RUN_STATUSES.has(view.runStatus);
}

function findEntryCoveringSession(sessionId: string): RunViewEntry | undefined {
  for (const entry of entriesBySessionId.values()) {
    if (
      entry.snapshot.view &&
      runViewContainsSession(entry.snapshot.view, sessionId)
    ) {
      return entry;
    }
  }
  return undefined;
}

function isCurrentEntry(entry: RunViewEntry): boolean {
  return !entry.retired && entriesBySessionId.get(entry.sessionId) === entry;
}

function cancelEntryEviction(entry: RunViewEntry): void {
  if (entry.evictionTimer === null) return;
  clearTimeout(entry.evictionTimer);
  entry.evictionTimer = null;
}

function scheduleEntryEviction(entry: RunViewEntry): void {
  if (
    !isCurrentEntry(entry) ||
    entry.subscribers.size > 0 ||
    entry.evictionTimer !== null
  ) {
    return;
  }
  entry.evictionTimer = setTimeout(() => {
    entry.evictionTimer = null;
    evictEntry(entry);
  }, AGENT_ORG_RUN_VIEW_CACHE_RETENTION_MS);
}

function evictEntry(entry: RunViewEntry): void {
  if (!isCurrentEntry(entry) || entry.subscribers.size > 0) return;
  entry.retired = true;
  entriesBySessionId.delete(entry.sessionId);
  if (bootstrapOwner === entry) bootstrapOwner = null;

  const sessionKey = `session:${entry.sessionId}`;
  inFlightByRunOrSession.delete(sessionKey);
  refreshAfterInFlight.delete(sessionKey);

  const runId = entry.snapshot.view?.context.runId;
  if (!runId) return;
  const hasOtherRunEntry = Array.from(entriesBySessionId.values()).some(
    (candidate) => candidate.snapshot.view?.context.runId === runId
  );
  if (!hasOtherRunEntry) {
    const runKey = `run:${runId}`;
    inFlightByRunOrSession.delete(runKey);
    refreshAfterInFlight.delete(runKey);
    latestRequestIdByRun.delete(runId);
  }
}

function getOrCreateEntry(sessionId: string): RunViewEntry {
  const existing = entriesBySessionId.get(sessionId);
  if (existing) return existing;

  const coveringEntry = findEntryCoveringSession(sessionId);
  const seededView = coveringEntry?.snapshot.view
    ? viewForSession(coveringEntry.snapshot.view, sessionId)
    : null;
  const entry: RunViewEntry = {
    sessionId,
    snapshot: seededView
      ? { view: seededView, error: coveringEntry?.snapshot.error ?? null }
      : EMPTY_SNAPSHOT,
    serializedView: seededView ? JSON.stringify(seededView) : null,
    subscribers: new Set(),
    discoveryAttempts: seededView ? MAX_NON_ORG_DISCOVERY_ATTEMPTS : 0,
    evictionTimer: null,
    bootstrapWait: null,
    lastAppliedRequestId: 0,
    hasBeenSubscribed: false,
    retired: false,
  };
  entriesBySessionId.set(sessionId, entry);
  // React can call getSnapshot for a render that is abandoned before
  // subscribe. Keep that generation bounded just like an unsubscribed entry.
  scheduleEntryEviction(entry);
  return entry;
}

function publishEntry(
  entry: RunViewEntry,
  view: AgentOrgRunView | null,
  error: string | null,
  requestId?: number
): boolean {
  if (!isCurrentEntry(entry)) return false;
  if (requestId !== undefined) {
    if (requestId < entry.lastAppliedRequestId) return false;
    entry.lastAppliedRequestId = requestId;
  }
  const serializedView = view ? JSON.stringify(view) : null;
  if (
    entry.serializedView === serializedView &&
    entry.snapshot.error === error
  ) {
    return true;
  }
  entry.snapshot = { view, error };
  entry.serializedView = serializedView;
  for (const subscriber of entry.subscribers) subscriber();
  return true;
}

function publishRunView(view: AgentOrgRunView, requestId: number): void {
  scheduleInterventionExpiryRefresh(view);
  for (const entry of entriesBySessionId.values()) {
    if (
      !runViewContainsSession(view, entry.sessionId) &&
      entry.snapshot.view?.context.runId !== view.context.runId
    ) {
      continue;
    }
    entry.discoveryAttempts = MAX_NON_ORG_DISCOVERY_ATTEMPTS;
    publishEntry(entry, viewForSession(view, entry.sessionId), null, requestId);
  }
}

function liveReplacementForRun(
  runId: string,
  excluded: RunViewEntry
): RunViewEntry | undefined {
  return Array.from(entriesBySessionId.values()).find(
    (candidate) =>
      candidate !== excluded &&
      candidate.subscribers.size > 0 &&
      candidate.snapshot.view?.context.runId === runId
  );
}

function publishMissingRun(
  entry: RunViewEntry,
  requestId: number
): RunViewEntry | null {
  if (!isCurrentEntry(entry) || requestId < entry.lastAppliedRequestId) {
    return null;
  }
  const previousRunId = entry.snapshot.view?.context.runId;
  entry.discoveryAttempts += 1;
  publishEntry(entry, null, null, requestId);
  if (!previousRunId) return null;

  const replacement = liveReplacementForRun(previousRunId, entry);
  if (replacement) {
    // One session disappearing does not prove that the Run disappeared. Ask a
    // live peer before clearing the shared projection.
    return replacement;
  }

  // No live session can verify the old Run. Clear every retained projection
  // so an inactive member panel cannot keep a ghost board indefinitely.
  for (const related of entriesBySessionId.values()) {
    if (related.snapshot.view?.context.runId !== previousRunId) continue;
    related.discoveryAttempts = MAX_NON_ORG_DISCOVERY_ATTEMPTS;
    publishEntry(related, null, null, requestId);
  }
  return null;
}

function scheduleInterventionExpiryRefresh(view: AgentOrgRunView): void {
  const runId = view.context.runId;
  const existing = interventionExpiryTimers.get(runId);
  if (existing) clearTimeout(existing);
  interventionExpiryTimers.delete(runId);

  const now = Date.now();
  const nextExpiry = view.members.reduce<number | null>((soonest, member) => {
    const intervention =
      member.intervention ?? member.sessionRuntime?.intervention ?? null;
    if (!intervention) return soonest;
    const expiresAt = Date.parse(intervention.resumeAfter);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return soonest;
    return soonest === null ? expiresAt : Math.min(soonest, expiresAt);
  }, null);
  if (nextExpiry === null) return;

  const timer = setTimeout(() => {
    interventionExpiryTimers.delete(runId);
    scheduleRunRefresh(runId);
  }, nextExpiry - now);
  interventionExpiryTimers.set(runId, timer);
}

function requestKey(entry: RunViewEntry): string {
  const runId = entry.snapshot.view?.context.runId;
  return runId ? `run:${runId}` : `session:${entry.sessionId}`;
}

function waitForBootstrapOwner(
  owner: RunViewEntry,
  request: Promise<void>
): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // A hung discovery for one session must not serialize every unrelated
      // session forever. Its eventual response remains guarded by generation
      // and request ordering.
      if (bootstrapOwner === owner) bootstrapOwner = null;
      resolve();
    }, AGENT_ORG_BOOTSTRAP_JOIN_TIMEOUT_MS);
    request.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      () => {
        clearTimeout(timeout);
        resolve();
      }
    );
  });
}

function refreshAgentOrgRunViewInternal(
  sessionId: string,
  queueIfBusy: boolean
): Promise<void> {
  const matchingEntry =
    entriesBySessionId.get(sessionId) ?? findEntryCoveringSession(sessionId);
  const entry = matchingEntry ?? getOrCreateEntry(sessionId);
  const key = requestKey(entry);
  const existing = inFlightByRunOrSession.get(key);
  if (existing) {
    if (queueIfBusy) refreshAfterInFlight.add(key);
    return existing;
  }

  if (
    entry.snapshot.view === null &&
    bootstrapOwner &&
    bootstrapOwner !== entry
  ) {
    if (entry.bootstrapWait) return entry.bootstrapWait;
    const owner = bootstrapOwner;
    const ownerRequest = inFlightByRunOrSession.get(requestKey(owner));
    if (ownerRequest) {
      const wait = waitForBootstrapOwner(owner, ownerRequest).then(async () => {
        if (!isCurrentEntry(entry) || entry.snapshot.view !== null) return;
        if (entry.subscribers.size > 0 || queueIfBusy) {
          await refreshAgentOrgRunViewInternal(entry.sessionId, queueIfBusy);
        }
      });
      entry.bootstrapWait = wait;
      void wait.finally(() => {
        if (entry.bootstrapWait === wait) entry.bootstrapWait = null;
      });
      return wait;
    }
    bootstrapOwner = null;
  }

  const requestId = ++nextRequestId;
  const knownRunId = entry.snapshot.view?.context.runId;
  if (knownRunId) latestRequestIdByRun.set(knownRunId, requestId);
  if (!knownRunId) bootstrapOwner = entry;

  let missingRunReplacement: RunViewEntry | null = null;
  const request = getAgentOrgSessionRunView(entry.sessionId)
    .then((view) => {
      if (!isCurrentEntry(entry)) return;
      if (view) {
        const runId = view.context.runId;
        const latestRequestId = latestRequestIdByRun.get(runId) ?? 0;
        if (requestId < latestRequestId) return;
        latestRequestIdByRun.set(runId, requestId);
        publishRunView(view, requestId);
        return;
      }
      missingRunReplacement = publishMissingRun(entry, requestId);
    })
    .catch((error: unknown) => {
      if (!isCurrentEntry(entry)) return;
      const message = error instanceof Error ? error.message : String(error);
      publishEntry(entry, entry.snapshot.view, message, requestId);
    })
    .finally(() => {
      if (bootstrapOwner === entry) bootstrapOwner = null;
      if (inFlightByRunOrSession.get(key) === request) {
        inFlightByRunOrSession.delete(key);
      }
      const runId = entry.snapshot.view?.context.runId;
      const runKey = runId ? `run:${runId}` : undefined;
      if (runKey && inFlightByRunOrSession.get(runKey) === request) {
        inFlightByRunOrSession.delete(runKey);
      }
      const shouldRefreshAgain =
        refreshAfterInFlight.delete(key) ||
        (runKey ? refreshAfterInFlight.delete(runKey) : false);
      if (
        shouldRefreshAgain &&
        isCurrentEntry(entry) &&
        entry.subscribers.size > 0
      ) {
        void refreshAgentOrgRunViewInternal(entry.sessionId, false);
      } else if (
        missingRunReplacement &&
        isCurrentEntry(missingRunReplacement) &&
        missingRunReplacement.subscribers.size > 0
      ) {
        void refreshAgentOrgRunViewInternal(
          missingRunReplacement.sessionId,
          false
        );
      }
    });
  inFlightByRunOrSession.set(key, request);
  return request;
}

export function refreshAgentOrgRunView(sessionId: string): Promise<void> {
  return refreshAgentOrgRunViewInternal(sessionId, true);
}

function scheduleRunRefresh(runId: string): void {
  if (pushDebounceTimers.has(runId)) return;
  const timer = setTimeout(() => {
    pushDebounceTimers.delete(runId);
    const entry = Array.from(entriesBySessionId.values()).find(
      (candidate) =>
        candidate.subscribers.size > 0 &&
        candidate.snapshot.view?.context.runId === runId
    );
    if (entry) void refreshAgentOrgRunViewInternal(entry.sessionId, true);
  }, AGENT_ORG_RUN_VIEW_PUSH_DEBOUNCE_MS);
  pushDebounceTimers.set(runId, timer);
}

function pollActiveRuns(): void {
  if (!isDocumentVisible()) return;

  const representatives = new Map<string, string>();
  for (const entry of entriesBySessionId.values()) {
    if (entry.subscribers.size === 0 || isTerminal(entry.snapshot.view))
      continue;
    if (
      entry.snapshot.view === null &&
      entry.discoveryAttempts >= MAX_NON_ORG_DISCOVERY_ATTEMPTS
    ) {
      continue;
    }
    representatives.set(requestKey(entry), entry.sessionId);
  }
  for (const sessionId of representatives.values()) {
    void refreshAgentOrgRunViewInternal(sessionId, false);
  }
}

function handleVisibilityChange(): void {
  if (isDocumentVisible()) pollActiveRuns();
}

function startScheduler(): void {
  if (!pollingTimer) {
    pollingTimer = setInterval(pollActiveRuns, AGENT_ORG_RUN_VIEW_FALLBACK_MS);
  }
  if (!unsubscribeStateChanges) {
    unsubscribeStateChanges = subscribeAgentOrgStateChanges((sessionId) => {
      const entry =
        entriesBySessionId.get(sessionId) ??
        findEntryCoveringSession(sessionId);
      const runId = entry?.snapshot.view?.context.runId;
      if (runId) scheduleRunRefresh(runId);
      else if (entry)
        void refreshAgentOrgRunViewInternal(entry.sessionId, true);
    });
  }
  if (!unsubscribeBackendChanges) {
    unsubscribeBackendChanges = getCodeEditorWebSocket()?.on(
      "agent_org:run_changed",
      (event) => {
        const payload = event.payload as { orgRunId?: unknown } | undefined;
        if (typeof payload?.orgRunId === "string") {
          scheduleRunRefresh(payload.orgRunId);
        }
      }
    );
  }
  if (!unsubscribeCliSessionChanges) {
    unsubscribeCliSessionChanges = getCodeEditorWebSocket()?.on(
      "code_session.status_changed",
      (event) => {
        const sessionId = (event as { session_id?: unknown }).session_id;
        if (typeof sessionId !== "string") return;
        const entry =
          entriesBySessionId.get(sessionId) ??
          findEntryCoveringSession(sessionId);
        const runId = entry?.snapshot.view?.context.runId;
        if (runId) scheduleRunRefresh(runId);
      }
    );
  }
  if (!unsubscribeWebsocketConnected) {
    unsubscribeWebsocketConnected = getCodeEditorWebSocket()?.on(
      "connected",
      pollActiveRuns
    );
  }
  if (typeof document !== "undefined" && !visibilityListenerInstalled) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    visibilityListenerInstalled = true;
  }
  const scheduledRuns = new Set<string>();
  for (const entry of entriesBySessionId.values()) {
    const view = entry.snapshot.view;
    if (!view || scheduledRuns.has(view.context.runId)) continue;
    scheduledRuns.add(view.context.runId);
    scheduleInterventionExpiryRefresh(view);
  }
}

function stopScheduler(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
  unsubscribeStateChanges?.();
  unsubscribeStateChanges = undefined;
  unsubscribeBackendChanges?.();
  unsubscribeBackendChanges = undefined;
  unsubscribeCliSessionChanges?.();
  unsubscribeCliSessionChanges = undefined;
  unsubscribeWebsocketConnected?.();
  unsubscribeWebsocketConnected = undefined;
  for (const timer of pushDebounceTimers.values()) clearTimeout(timer);
  pushDebounceTimers.clear();
  for (const timer of interventionExpiryTimers.values()) clearTimeout(timer);
  interventionExpiryTimers.clear();
  if (typeof document !== "undefined" && visibilityListenerInstalled) {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    visibilityListenerInstalled = false;
  }
}

export function subscribeAgentOrgRunView(
  sessionId: string,
  subscriber: Subscriber
): () => void {
  const entry = getOrCreateEntry(sessionId);
  cancelEntryEviction(entry);
  const isReturningSubscriber =
    entry.hasBeenSubscribed && entry.subscribers.size === 0;
  entry.hasBeenSubscribed = true;
  const subscription = () => subscriber();
  entry.subscribers.add(subscription);
  activeSubscriberCount += 1;
  if (activeSubscriberCount === 1) startScheduler();
  if (entry.snapshot.view === null && entry.discoveryAttempts === 0) {
    void refreshAgentOrgRunViewInternal(sessionId, false);
  } else if (isReturningSubscriber && entry.snapshot.view !== null) {
    // Retained entries stop receiving push events after their last subscriber
    // leaves. Refresh immediately when the UI reopens the session instead of
    // showing a stale Run status until the fallback poll fires.
    void refreshAgentOrgRunViewInternal(sessionId, false);
  }

  return () => {
    if (!entry.subscribers.delete(subscription)) return;
    activeSubscriberCount -= 1;
    if (activeSubscriberCount === 0) stopScheduler();
    scheduleEntryEviction(entry);
  };
}

export function getAgentOrgRunViewSnapshot(
  sessionId: string
): AgentOrgRunViewSnapshot {
  return getOrCreateEntry(sessionId).snapshot;
}

/** Narrow test seam for cache-generation and shared-poller invariants. */
export const agentOrgRunViewStoreTestApi = {
  subscribe: subscribeAgentOrgRunView,
  getSnapshot: getAgentOrgRunViewSnapshot,
  refresh: refreshAgentOrgRunView,
  hasEntry(sessionId: string): boolean {
    return entriesBySessionId.has(sessionId);
  },
  ownerSessionId(runId: string): string | null {
    return (
      Array.from(entriesBySessionId.values()).find(
        (entry) =>
          entry.subscribers.size > 0 &&
          entry.snapshot.view?.context.runId === runId
      )?.sessionId ?? null
    );
  },
  reset(): void {
    stopScheduler();
    for (const entry of entriesBySessionId.values()) {
      cancelEntryEviction(entry);
      entry.subscribers.clear();
      entry.retired = true;
    }
    entriesBySessionId.clear();
    inFlightByRunOrSession.clear();
    latestRequestIdByRun.clear();
    refreshAfterInFlight.clear();
    bootstrapOwner = null;
    nextRequestId = 0;
    activeSubscriberCount = 0;
  },
};
