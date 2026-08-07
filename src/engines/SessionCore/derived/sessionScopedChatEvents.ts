/**
 * Per-session ChatEvents pipeline.
 *
 * The default `chatEventsAtom` is keyed to the globally-active session
 * (`sessionIdAtom`). That is correct for the primary ChatPanel which always
 * mirrors the active session, but it cannot serve the subagent bottom strip
 * where multiple ChatHistory instances must concurrently render different
 * subagent sessions.
 *
 * This module exposes a session-scoped atom family that subscribes directly
 * to the per-session snapshot channel on `eventStoreProxy`, so each
 * ChatHistory instance with a `ChatSessionContext` override reads its own
 * snapshot stream. The global atom is left untouched.
 *
 * Race-safety notes:
 *
 * - Each atom-family entry owns its own `_prevChatEvents` cache via closure,
 *   so the reference-stability comparison cannot bleed across sessions the
 *   way the module-level cache in `chatEvents.ts` does.
 * - The subscription is established eagerly in `onMount` and cleaned up in
 *   the returned disposer; a `getLatestSessionSnapshot` poll closes the race
 *   between mount and the next push.
 * - Family entries are explicitly removed (jotai-family pins them in a
 *   strong Map otherwise) once the snapshot atom has been unmounted for
 *   SESSION_FAMILY_RETAIN_MS. The Rust EventStore keeps its own LRU cache;
 *   we only mirror what is mounted or recently unmounted.
 */
import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import { createLogger } from "@src/hooks/logger";

import { isInteractiveTool } from "../core/interactiveTools";
import {
  hasLiveRuntimeResourceInLatestTurn,
  hasRunningAwaitWaitForInLatestTurn,
} from "../core/runningEventGate";
import type { Snapshot } from "../core/store/EventStoreProxy";
import {
  eventStoreProxy,
  isStreamingSnapshot,
} from "../core/store/EventStoreProxy";
import type { SessionEvent } from "../core/types";
import {
  derivePlanDisplayEvents,
  planEventContentSignature,
} from "./planDisplayEvents";

const log = createLogger("sessionScopedChatEvents");

interface SnapshotState {
  snapshot: Snapshot | null;
  loadStarted: boolean;
}

const EMPTY_STATE: SnapshotState = {
  snapshot: null,
  loadStarted: false,
};

/**
 * Family GC. `jotai-family` pins every created atom in a strong Map until
 * `remove()` is called, so without this each subagent session ever rendered
 * would keep its last full snapshot (and derived chat-events array) on the
 * heap for the app lifetime. Entries are released once the session's
 * snapshot atom has been unmounted for SESSION_FAMILY_RETAIN_MS — long
 * enough that grid-layout churn and quick switch-backs stay warm, short
 * enough that hopping across many replays doesn't accumulate transcripts.
 *
 * Removal is mount-gated and therefore glitch-free: the two derived families
 * read `sessionSnapshotAtomFamily`, so none of the three can still be
 * mounted when the snapshot atom's unmount cleanup fires, and a remount
 * within the grace period cancels the pending removal.
 */
export const SESSION_FAMILY_RETAIN_MS = 3 * 60 * 1000;

const familyRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelSessionFamilyRemoval(sessionId: string): void {
  const timer = familyRemovalTimers.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  familyRemovalTimers.delete(sessionId);
}

function scheduleSessionFamilyRemoval(sessionId: string): void {
  cancelSessionFamilyRemoval(sessionId);
  const timer = setTimeout(() => {
    familyRemovalTimers.delete(sessionId);
    chatEventsForSessionAtomFamily.remove(sessionId);
    sessionScopedPlanningMetaAtomFamily.remove(sessionId);
    sessionSnapshotAtomFamily.remove(sessionId);
  }, SESSION_FAMILY_RETAIN_MS);
  familyRemovalTimers.set(sessionId, timer);
}

/**
 * Backing snapshot atom for a single subagent session.
 *
 * Subscribes to `eventStoreProxy.subscribeSession(sessionId, ...)` on mount,
 * primes itself with `getLatestSessionSnapshot`, and triggers a one-shot
 * `loadFromCache` so a fresh subagent that has not been fetched yet hydrates
 * without requiring the consumer to call `useSessionEvents` separately.
 */
const sessionSnapshotAtomFamily = atomFamily((sessionId: string) => {
  const a = atom<SnapshotState>(EMPTY_STATE);
  a.debugLabel = `session/${sessionId}/snapshot`;

  a.onMount = (setSelf) => {
    let disposed = false;
    cancelSessionFamilyRemoval(sessionId);

    setSelf((prev) => {
      if (prev.loadStarted) return prev;
      const cached = eventStoreProxy.getLatestSessionSnapshot(sessionId);
      return {
        snapshot: cached ?? prev.snapshot,
        loadStarted: true,
      };
    });

    const unsubscribe = eventStoreProxy.subscribeSession(
      sessionId,
      (snapshot) => {
        if (disposed) return;
        setSelf({ snapshot, loadStarted: true });
      }
    );

    // Best-effort hydration. If the session is already in the Rust LRU
    // cache this triggers a `schedule_notify` and the snapshot lands via
    // the subscription above; if it is not loaded yet, Rust loads it from
    // SQLite. We do not await — the subscription handles the push.
    void eventStoreProxy.loadFromCache(sessionId).catch((err: unknown) => {
      // Swallow load errors here: the consumer (ChatHistory) is allowed
      // to render an empty state. `useSessionEvents` already covers
      // explicit error surfacing for callers that need it.
      log.warn(
        `[sessionScopedChatEvents] loadFromCache(${sessionId}) failed:`,
        err
      );
    });

    return () => {
      disposed = true;
      unsubscribe();
      scheduleSessionFamilyRemoval(sessionId);
    };
  };

  return a;
});

function extractChatEvents(snapshot: Snapshot | null): SessionEvent[] {
  if (!snapshot) return [];
  if (isStreamingSnapshot(snapshot)) {
    return snapshot.chatEvents;
  }
  if ("chatEvents" in snapshot) {
    return snapshot.chatEvents;
  }
  return [];
}

function chatEventsStable(
  next: SessionEvent[],
  prev: SessionEvent[],
  streaming: boolean
): boolean {
  if (streaming) return false;
  if (next.length !== prev.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i].id !== prev[i].id) return false;
    if (next[i].displayStatus !== prev[i].displayStatus) return false;
    if (next[i].isDelta !== prev[i].isDelta) return false;
    const na = next[i].args as Record<string, unknown> | undefined;
    const pa = prev[i].args as Record<string, unknown> | undefined;
    if (na?.["action"] !== pa?.["action"]) return false;
    if (na?.["subagentSessionId"] !== pa?.["subagentSessionId"]) return false;
    if (
      planEventContentSignature(next[i]) !== planEventContentSignature(prev[i])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Session-scoped chat events. Each family entry has its own `_prev` closure
 * so the reference-stability check cannot leak across sessions even when
 * multiple ChatHistory instances render in parallel inside the subagent
 * bottom strip.
 */
export const chatEventsForSessionAtomFamily = atomFamily(
  (sessionId: string) => {
    let prevChatEvents: SessionEvent[] = [];

    const a = atom((get) => {
      const { snapshot } = get(sessionSnapshotAtomFamily(sessionId));
      const next = derivePlanDisplayEvents(extractChatEvents(snapshot));
      const streaming = snapshot ? isStreamingSnapshot(snapshot) : false;
      if (chatEventsStable(next, prevChatEvents, streaming)) {
        return prevChatEvents;
      }
      prevChatEvents = next;
      return next;
    });
    a.debugLabel = `session/${sessionId}/chatEvents`;
    return a;
  }
);

/**
 * Per-session planning-footer signals, mirroring what the global
 * `usePlanningIndicator` derives from `derivedSnapshotAtom` /
 * `eventStoreVersionAtom` — but read from this session's own snapshot
 * channel so session-scoped ChatHistory instances (subagent monitor
 * cells) get a live footer driven by the RIGHT session.
 */
export interface SessionScopedPlanningMeta {
  /** Snapshot version — bumps on every store mutation for this session. */
  version: number;
  /** True when any chat-visible event is still a live runtime resource. */
  anyRunning: boolean;
  /** True while an interactive tool is blocked waiting for user input. */
  hasAwaitingUserInteraction: boolean;
  /**
   * True while the latest turn has a still-running `await_output` wait_for —
   * its own live countdown title makes the planning footer redundant.
   */
  hasRunningAwaitWaitFor: boolean;
}

const EMPTY_PLANNING_META: SessionScopedPlanningMeta = {
  version: 0,
  anyRunning: false,
  hasAwaitingUserInteraction: false,
  hasRunningAwaitWaitFor: false,
};

export const sessionScopedPlanningMetaAtomFamily = atomFamily(
  (sessionId: string) => {
    let prev: SessionScopedPlanningMeta = EMPTY_PLANNING_META;

    const a = atom((get) => {
      const { snapshot } = get(sessionSnapshotAtomFamily(sessionId));
      if (!snapshot) return EMPTY_PLANNING_META;
      const chatEvents = extractChatEvents(snapshot);
      const next: SessionScopedPlanningMeta = {
        version: snapshot.version,
        anyRunning: hasLiveRuntimeResourceInLatestTurn(chatEvents),
        hasAwaitingUserInteraction: chatEvents.some(
          (event) =>
            event.displayStatus === "awaiting_user" &&
            event.activityStatus !== "processed" &&
            isInteractiveTool(event.functionName)
        ),
        hasRunningAwaitWaitFor: hasRunningAwaitWaitForInLatestTurn(chatEvents),
      };
      if (
        next.version === prev.version &&
        next.anyRunning === prev.anyRunning &&
        next.hasAwaitingUserInteraction === prev.hasAwaitingUserInteraction &&
        next.hasRunningAwaitWaitFor === prev.hasRunningAwaitWaitFor
      ) {
        return prev;
      }
      prev = next;
      return next;
    });
    a.debugLabel = `session/${sessionId}/planningMeta`;
    return a;
  }
);

/** Stable fallback for unscoped consumers (keeps hook call order legal). */
export const noopSessionScopedPlanningMetaAtom =
  atom<SessionScopedPlanningMeta>(EMPTY_PLANNING_META);
noopSessionScopedPlanningMetaAtom.debugLabel = "session/noop/planningMeta";
