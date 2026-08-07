import { useSyncExternalStore } from "react";

type HoverCardPosition = "bottom-start" | "right-start";

const DEFAULT_POSITION: HoverCardPosition = "bottom-start";

export interface HoverCardState {
  /**
   * The trigger instance that currently owns the card. Two triggers with the
   * same `sessionId` (e.g. a sidebar row and the ChatPanel header for the
   * active session) must NOT both render a portal, so ownership is tracked
   * by instance — not by sessionId.
   */
  activeInstanceId: number | null;
  /** Identifier whose card is currently shown, or `null` when nothing is visible. */
  activeCardId: string | null;
  /** Anchor rect for the active trigger — drives the portal positioning. */
  triggerRect: DOMRect | null;
  /** Position style for the active trigger. */
  position: HoverCardPosition;
  /** Bumped whenever the state changes; used by `useSyncExternalStore`. */
  revision: number;
}

const initialState: HoverCardState = {
  activeInstanceId: null,
  activeCardId: null,
  triggerRect: null,
  position: DEFAULT_POSITION,
  revision: 0,
};

let state: HoverCardState = initialState;
let pendingCloseTimer: ReturnType<typeof setTimeout> | null = null;
let nextInstanceId = 1;
const storeSubscribers = new Set<() => void>();

function notifyStoreSubscribers(): void {
  for (const fn of storeSubscribers) fn();
}

function subscribeStore(fn: () => void): () => void {
  storeSubscribers.add(fn);
  return () => {
    storeSubscribers.delete(fn);
  };
}

function getStoreSnapshot(): HoverCardState {
  return state;
}

export function allocateInstanceId(): number {
  const id = nextInstanceId;
  nextInstanceId += 1;
  return id;
}

export function cancelPendingClose(): void {
  if (pendingCloseTimer !== null) {
    clearTimeout(pendingCloseTimer);
    pendingCloseTimer = null;
  }
}

/** Immediately hides the active card (for example, when its row is clicked). */
export function dismissHoverCard(): void {
  cancelPendingClose();
  if (state.activeInstanceId === null) return;
  state = {
    activeInstanceId: null,
    activeCardId: null,
    triggerRect: null,
    position: DEFAULT_POSITION,
    revision: state.revision + 1,
  };
  notifyStoreSubscribers();
}

export function openCard(
  instanceId: number,
  cardId: string,
  triggerRect: DOMRect,
  position: HoverCardPosition
): void {
  cancelPendingClose();
  state = {
    activeInstanceId: instanceId,
    activeCardId: cardId,
    triggerRect,
    position,
    revision: state.revision + 1,
  };
  notifyStoreSubscribers();
}

export function scheduleClose(instanceId: number, delayMs: number): void {
  if (state.activeInstanceId !== instanceId) return;
  cancelPendingClose();
  pendingCloseTimer = setTimeout(() => {
    pendingCloseTimer = null;
    if (state.activeInstanceId !== instanceId) return;
    state = {
      activeInstanceId: null,
      activeCardId: null,
      triggerRect: null,
      position: DEFAULT_POSITION,
      revision: state.revision + 1,
    };
    notifyStoreSubscribers();
  }, delayMs);
}

export function useHoverCardState(): HoverCardState {
  return useSyncExternalStore(
    subscribeStore,
    getStoreSnapshot,
    getStoreSnapshot
  );
}
