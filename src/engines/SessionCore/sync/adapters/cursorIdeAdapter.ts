/**
 * Cursor IDE EventStore preload helpers.
 *
 * Cursor IDE history is loaded through the generic external-history adapter.
 * This module only keeps Cursor-specific lazy preload/snapshot helpers used by
 * turn expansion and session-switch freshness checks.
 */
import {
  cursorIdeFullRefresh,
  cursorIdeInitialWindow,
} from "@src/api/tauri/externalHistory";
import { cursorIdeComposerLastUpdatedAt } from "@src/api/tauri/externalHistory/cursorIde";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { processChunksRust } from "@src/engines/SessionCore/ingestion/rustBridge";
import { cursorIdeTurnSummariesAtomFamily } from "@src/store/session/cursorIdeTurnSummariesAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import {
  composerIdFromSessionId,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

const CURSOR_IDE_INITIAL_RECENT_BUBBLE_LIMIT = 100;

const cursorIdeSnapshotLastUpdatedAtBySession = new Map<string, number>();

export function getCursorIdeSnapshotLastUpdatedAt(
  sessionId: string
): number | null {
  return cursorIdeSnapshotLastUpdatedAtBySession.get(sessionId) ?? null;
}

async function refreshCursorIdeSnapshotLastUpdatedAt(
  sessionId: string
): Promise<void> {
  const composerId = composerIdFromSessionId(sessionId);
  if (!composerId) return;
  const lastUpdatedAt = await cursorIdeComposerLastUpdatedAt(composerId);
  if (lastUpdatedAt !== null) {
    cursorIdeSnapshotLastUpdatedAtBySession.set(sessionId, lastUpdatedAt);
  }
}

interface CursorIdeReloadState {
  inFlight: Promise<void> | null;
  needsReloadAfterCurrent: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  debouncedPromise: Promise<void> | null;
  resolveDebounced: (() => void) | null;
  rejectDebounced: ((error: unknown) => void) | null;
}

const cursorIdeReloadStates = new Map<string, CursorIdeReloadState>();
const CURSOR_IDE_FORCED_RELOAD_DEBOUNCE_MS = 250;

function getCursorIdeReloadState(sessionId: string): CursorIdeReloadState {
  let state = cursorIdeReloadStates.get(sessionId);
  if (!state) {
    state = {
      inFlight: null,
      needsReloadAfterCurrent: false,
      debounceTimer: null,
      debouncedPromise: null,
      resolveDebounced: null,
      rejectDebounced: null,
    };
    cursorIdeReloadStates.set(sessionId, state);
  }
  return state;
}

/**
 * Lazy-load a Cursor IDE session's events into the EventStore so any
 * `useSessionEvents(sessionId)` consumer (notably nested SubagentBlocks
 * expanded inside a parent Cursor history view) can replay them.
 *
 * Idempotent and safe to call repeatedly:
 * - returns immediately if the session id is not a `cursoride-*` id
 * - returns immediately if the EventStore already has events for this id
 * - coalesces concurrent in-flight loads on the same id
 *
 * The EventStore push uses `set` (not `mergeEvents`) because cursor history
 * is immutable on disk — there is nothing to merge with, and `set` is
 * cheaper. The events live alongside CLI/agent sessions in the same Rust
 * LRU; eviction is fine because we can always reload from `state.vscdb`.
 */
export async function ensureCursorIdeEventsInStore(
  sessionId: string,
  options?: { forceReload?: boolean }
): Promise<void> {
  if (!isCursorIdeSession(sessionId)) return;

  const force = options?.forceReload === true;
  if (!force) {
    const existing = eventStoreProxy.getLatestSessionSnapshot(sessionId);
    if (existing && existing.eventCount > 0) return;
  }

  const state = getCursorIdeReloadState(sessionId);
  if (!force && state.inFlight) return state.inFlight;
  if (!force) return runCursorIdeScheduledReload(sessionId, state, false);
  return scheduleCursorIdeForcedReload(sessionId, state);
}

function scheduleCursorIdeForcedReload(
  sessionId: string,
  state: CursorIdeReloadState
): Promise<void> {
  if (state.inFlight) {
    state.needsReloadAfterCurrent = true;
    return state.inFlight;
  }

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }

  if (!state.debouncedPromise) {
    state.debouncedPromise = new Promise<void>((resolve, reject) => {
      state.resolveDebounced = resolve;
      state.rejectDebounced = reject;
    });
  }

  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    const promiseToResolve = state.resolveDebounced;
    const promiseToReject = state.rejectDebounced;
    state.debouncedPromise = null;
    state.resolveDebounced = null;
    state.rejectDebounced = null;

    void runCursorIdeScheduledReload(sessionId, state, true).then(
      () => promiseToResolve?.(),
      (error: unknown) => promiseToReject?.(error)
    );
  }, CURSOR_IDE_FORCED_RELOAD_DEBOUNCE_MS);

  return state.debouncedPromise;
}

function runCursorIdeScheduledReload(
  sessionId: string,
  state: CursorIdeReloadState,
  force: boolean
): Promise<void> {
  if (state.inFlight) {
    if (force) state.needsReloadAfterCurrent = true;
    return state.inFlight;
  }

  const work = (async () => {
    try {
      await loadCursorIdeEventsIntoStore(sessionId, force);
      while (state.needsReloadAfterCurrent) {
        state.needsReloadAfterCurrent = false;
        await loadCursorIdeEventsIntoStore(sessionId, true);
      }
    } finally {
      state.inFlight = null;
      if (!state.debounceTimer && !state.debouncedPromise) {
        cursorIdeReloadStates.delete(sessionId);
      }
    }
  })();
  state.inFlight = work;
  return work;
}

async function loadCursorIdeEventsIntoStore(
  sessionId: string,
  force: boolean
): Promise<void> {
  const loadResult = force
    ? await cursorIdeFullRefresh(sessionId)
    : await cursorIdeInitialWindow({
        sessionId,
        recentLimit: CURSOR_IDE_INITIAL_RECENT_BUBBLE_LIMIT,
      });

  getInstrumentedStore().set(
    cursorIdeTurnSummariesAtomFamily(sessionId),
    loadResult.turns
  );

  if (!Array.isArray(loadResult.chunks) || loadResult.chunks.length === 0) {
    return;
  }
  const events = await processChunksRust(loadResult.chunks, sessionId);
  if (events.length === 0) return;
  await eventStoreProxy.set(events, sessionId);
  await refreshCursorIdeSnapshotLastUpdatedAt(sessionId);
}
