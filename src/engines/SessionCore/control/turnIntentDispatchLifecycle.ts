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
const recentDispatches = new Map<string, TurnIntentDispatch>();
const waiters = new Map<string, Set<(dispatch: TurnIntentDispatch) => void>>();

export function publishTurnIntentDispatch(
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
  const listeners = waiters.get(turnIntentId);
  if (!listeners) return;
  waiters.delete(turnIntentId);
  for (const listener of listeners) listener(dispatch);
}

export function waitForTurnIntentDispatch(
  turnIntentId: string,
  deadlineMs: number
): Promise<TurnIntentDispatch> {
  const recent = recentDispatches.get(turnIntentId);
  if (recent) return Promise.resolve(recent);
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
  return recentDispatches.get(turnIntentId);
}

export function resetTurnIntentDispatchLifecycleForTests(): void {
  recentDispatches.clear();
  waiters.clear();
}
