import { atom } from "jotai";
import type { Store } from "jotai/vanilla/store";

export type CanvasRevisionDraftPhase = "receiving" | "applying";

/** Ephemeral progress for one in-flight revise_inline_canvas tool call. */
export interface CanvasRevisionDraft {
  sessionId: string;
  toolCallId: string;
  targetEventId?: string;
  mode?: string;
  title?: string;
  agentSteps?: string[];
  receivedCharacters: number;
  phase: CanvasRevisionDraftPhase;
  startedAt: number;
}

export const canvasRevisionDraftsAtom = atom<Map<string, CanvasRevisionDraft>>(
  new Map()
);
canvasRevisionDraftsAtom.debugLabel = "session/canvasRevisionDrafts";

const FLUSH_INTERVAL_MS = 50;

/** Metadata parsed out of the streamed args — expensive, so resolved lazily. */
export interface CanvasRevisionDraftMetadata {
  targetEventId?: string;
  mode?: string;
  title?: string;
  agentSteps?: string[];
}

interface PendingDraftEntry {
  draft: CanvasRevisionDraft;
  /**
   * Deferred metadata parse. Token-frequency deltas arrive far faster than
   * the 50ms flush cadence; resolving at flush time bounds the regex scans
   * to at most one per coalescer window instead of one per delta.
   */
  resolveMetadata?: () => CanvasRevisionDraftMetadata;
}

function materializePendingDraft(
  entry: PendingDraftEntry
): CanvasRevisionDraft {
  if (entry.resolveMetadata) {
    entry.draft = { ...entry.draft, ...entry.resolveMetadata() };
    entry.resolveMetadata = undefined;
  }
  return entry.draft;
}

interface StoreBufferState {
  pendingBySession: Map<string, PendingDraftEntry>;
  timer: ReturnType<typeof setTimeout> | null;
}

const bufferStateByStore = new WeakMap<Store, StoreBufferState>();

function bufferState(store: Store): StoreBufferState {
  let state = bufferStateByStore.get(store);
  if (!state) {
    state = { pendingBySession: new Map(), timer: null };
    bufferStateByStore.set(store, state);
  }
  return state;
}

function cancelTimer(state: StoreBufferState): void {
  if (state.timer === null) return;
  clearTimeout(state.timer);
  state.timer = null;
}

/** Flush all pending session drafts through one atom write for this store. */
export function flushCanvasRevisionDrafts(store: Store): void {
  const state = bufferState(store);
  cancelTimer(state);
  if (state.pendingBySession.size === 0) return;
  const updates = new Map(state.pendingBySession);
  state.pendingBySession.clear();
  store.set(canvasRevisionDraftsAtom, (previous) => {
    const next = new Map(previous);
    for (const [sessionId, entry] of updates) {
      next.set(sessionId, materializePendingDraft(entry));
    }
    return next;
  });
}

function scheduleFlush(store: Store, state: StoreBufferState): void {
  if (state.timer !== null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    flushCanvasRevisionDrafts(store);
  }, FLUSH_INTERVAL_MS);
}

/**
 * Coalesce token-frequency Canvas progress to at most 20Hz per Jotai store.
 * The first draft for a session is delivered immediately so feedback is not
 * delayed; later chunks share one trailing flush.
 *
 * `resolveMetadata` defers the expensive streamed-args parse to flush time —
 * only the entry that actually reaches the atom pays for it.
 */
export function bufferCanvasRevisionDraft(
  store: Store,
  incoming: Omit<CanvasRevisionDraft, "startedAt"> & {
    startedAt?: number;
    resolveMetadata?: () => CanvasRevisionDraftMetadata;
  }
): void {
  const state = bufferState(store);
  const visible = store.get(canvasRevisionDraftsAtom).get(incoming.sessionId);
  const pending = state.pendingBySession.get(incoming.sessionId);
  const previous = pending?.draft ?? visible;
  const sameCall = previous?.toolCallId === incoming.toolCallId;
  const { resolveMetadata, ...fields } = incoming;
  const draft: CanvasRevisionDraft = {
    ...fields,
    startedAt:
      incoming.startedAt ?? (sameCall ? previous.startedAt : Date.now()),
  };
  state.pendingBySession.set(incoming.sessionId, { draft, resolveMetadata });

  if (!visible || visible.toolCallId !== incoming.toolCallId) {
    flushCanvasRevisionDrafts(store);
    return;
  }
  scheduleFlush(store, state);
}

/** Move a matching draft into the short tool-execution/apply phase. */
export function markCanvasRevisionDraftApplying(
  store: Store,
  sessionId: string,
  toolCallId: string,
  receivedCharacters: number
): void {
  const state = bufferState(store);
  const pending = state.pendingBySession.get(sessionId);
  const visible = store.get(canvasRevisionDraftsAtom).get(sessionId);
  const current =
    pending?.draft.toolCallId === toolCallId
      ? materializePendingDraft(pending)
      : visible?.toolCallId === toolCallId
        ? visible
        : null;
  if (!current) return;
  state.pendingBySession.delete(sessionId);
  if (state.pendingBySession.size === 0) cancelTimer(state);
  store.set(canvasRevisionDraftsAtom, (previous) => {
    const latest = previous.get(sessionId);
    if (latest && latest.toolCallId !== toolCallId) return previous;
    const next = new Map(previous);
    next.set(sessionId, {
      ...current,
      phase: "applying",
      receivedCharacters: Math.max(
        current.receivedCharacters,
        receivedCharacters
      ),
    });
    return next;
  });
}

/** Clear only the matching operation so a late terminal cannot erase a newer draft. */
export function clearCanvasRevisionDraft(
  store: Store,
  sessionId: string,
  toolCallId?: string
): void {
  const state = bufferState(store);
  const pending = state.pendingBySession.get(sessionId);
  if (!toolCallId || pending?.draft.toolCallId === toolCallId) {
    state.pendingBySession.delete(sessionId);
  }
  if (state.pendingBySession.size === 0) cancelTimer(state);

  store.set(canvasRevisionDraftsAtom, (previous) => {
    const current = previous.get(sessionId);
    if (!current || (toolCallId && current.toolCallId !== toolCallId)) {
      return previous;
    }
    const next = new Map(previous);
    next.delete(sessionId);
    return next;
  });
}

/** Permanent session deletion path: drop pending and visible draft state. */
export function disposeCanvasRevisionDraftState(
  store: Store,
  sessionId: string
): void {
  clearCanvasRevisionDraft(store, sessionId);
}
