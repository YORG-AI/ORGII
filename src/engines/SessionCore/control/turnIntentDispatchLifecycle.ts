/**
 * Correlates a user intent with the exact turn generation that eventually
 * dispatches it. Direct submissions publish immediately; queued submissions
 * publish when the singleton queue dispatcher reserves their turn.
 *
 * This is intentionally a tiny process-local rendezvous, not another turn
 * state machine. Turn finality remains owned exclusively by turnLifecycle.ts.
 */
export interface TurnIntentDispatch {
  sessionId: string;
  generation: number;
}

const MAX_RECENT_DISPATCHES = 200;
/**
 * Active identities are never subject to the recent-history bound. A global
 * LRU may see hundreds of short turns while one tool-heavy turn is still
 * running; evicting that live mapping would make its exact terminal look
 * unattributed and leave the session permanently working.
 */
const activeDispatches = new Map<string, TurnIntentDispatch>();
const activeIntentsByTurn = new Map<string, Set<string>>();
const recentDispatches = new Map<string, TurnIntentDispatch>();
const waiters = new Map<string, Set<(dispatch: TurnIntentDispatch) => void>>();

function turnKey(dispatch: TurnIntentDispatch): string {
  return JSON.stringify([dispatch.sessionId, dispatch.generation]);
}

function removeActiveIntent(turnIntentId: string): TurnIntentDispatch | null {
  const dispatch = activeDispatches.get(turnIntentId);
  if (!dispatch) return null;
  activeDispatches.delete(turnIntentId);
  const key = turnKey(dispatch);
  const intents = activeIntentsByTurn.get(key);
  intents?.delete(turnIntentId);
  if (intents?.size === 0) activeIntentsByTurn.delete(key);
  return dispatch;
}

function retainRecent(
  turnIntentId: string,
  dispatch: TurnIntentDispatch
): void {
  recentDispatches.delete(turnIntentId);
  recentDispatches.set(turnIntentId, dispatch);
  while (recentDispatches.size > MAX_RECENT_DISPATCHES) {
    const oldest = recentDispatches.keys().next().value as string | undefined;
    if (!oldest) break;
    recentDispatches.delete(oldest);
  }
}

export function publishTurnIntentDispatch(
  turnIntentId: string,
  dispatch: TurnIntentDispatch
): void {
  removeActiveIntent(turnIntentId);
  recentDispatches.delete(turnIntentId);
  activeDispatches.set(turnIntentId, dispatch);
  const key = turnKey(dispatch);
  const intents = activeIntentsByTurn.get(key) ?? new Set<string>();
  intents.add(turnIntentId);
  activeIntentsByTurn.set(key, intents);
  const listeners = waiters.get(turnIntentId);
  if (!listeners) return;
  waiters.delete(turnIntentId);
  for (const listener of listeners) listener(dispatch);
}

/**
 * Bind a backend-selected intent id to an already-reserved local generation.
 *
 * Project/Work Item dispatch may replace the composer intent with a durable
 * run id. Both ids must resolve to the same generation, but an id that is
 * already bound anywhere else is an attribution conflict and must never be
 * overwritten.
 */
export function publishTurnIntentDispatchAlias(
  turnIntentId: string,
  dispatch: TurnIntentDispatch
): boolean {
  if (!turnIntentId) return false;
  const existing = getTurnIntentDispatch(turnIntentId);
  if (existing) {
    return (
      existing.sessionId === dispatch.sessionId &&
      existing.generation === dispatch.generation
    );
  }
  publishTurnIntentDispatch(turnIntentId, dispatch);
  return true;
}

export function waitForTurnIntentDispatch(
  turnIntentId: string,
  deadlineMs: number
): Promise<TurnIntentDispatch> {
  const known = getTurnIntentDispatch(turnIntentId);
  if (known) return Promise.resolve(known);
  return new Promise<TurnIntentDispatch>((resolve, reject) => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      reject(new Error("turn intent dispatch timed out"));
      return;
    }
    const listener = (dispatch: TurnIntentDispatch): void => {
      clearTimeout(timer);
      resolve(dispatch);
    };
    const timer = setTimeout(() => {
      const listeners = waiters.get(turnIntentId);
      listeners?.delete(listener);
      if (listeners?.size === 0) waiters.delete(turnIntentId);
      reject(new Error("turn intent dispatch timed out"));
    }, remainingMs);
    const listeners = waiters.get(turnIntentId) ?? new Set();
    listeners.add(listener);
    waiters.set(turnIntentId, listeners);
  });
}

export function getTurnIntentDispatch(
  turnIntentId: string
): TurnIntentDispatch | undefined {
  return (
    activeDispatches.get(turnIntentId) ?? recentDispatches.get(turnIntentId)
  );
}

/** Whether this exact local turn still owns at least one live intent id. */
export function hasActiveTurnIntentDispatch(
  sessionId: string,
  generation: number
): boolean {
  return activeIntentsByTurn.has(turnKey({ sessionId, generation }));
}

/** Move every identity for one finalized generation into bounded history. */
export function retireTurnIntentDispatch(
  sessionId: string,
  generation: number
): void {
  const key = turnKey({ sessionId, generation });
  const intents = activeIntentsByTurn.get(key);
  if (!intents) return;
  for (const turnIntentId of [...intents]) {
    const dispatch = removeActiveIntent(turnIntentId);
    if (dispatch) retainRecent(turnIntentId, dispatch);
  }
}

/** Session deletion invalidates all live mappings owned by that session. */
export function retireSessionTurnIntentDispatches(sessionId: string): void {
  for (const [turnIntentId, dispatch] of [...activeDispatches]) {
    if (dispatch.sessionId !== sessionId) continue;
    removeActiveIntent(turnIntentId);
  }
}

export function resetTurnIntentDispatchLifecycleForTests(): void {
  activeDispatches.clear();
  activeIntentsByTurn.clear();
  recentDispatches.clear();
  waiters.clear();
}
