/**
 * Session Channel Activity
 *
 * Last-seen timestamp of ANY event arriving on a session's per-session IPC
 * channel. This is the single liveness source for "is the backend still
 * feeding us events", independent of whether an event mutates the EventStore.
 *
 * Why not the EventStore `version`: several event classes are deliberately
 * ephemeral and never bump it — `agent:tool_call_delta` buffers in memory
 * only (see streamHandlers.ts), `agent:stream_retry` writes a side atom, etc.
 * A turn that spends minutes streaming one large tool call therefore looks
 * "dead" to any version-based watchdog while the channel is in fact busy.
 *
 * Deliberately NOT reactive (plain Map, no jotai atom): deltas arrive at
 * token frequency and must not trigger React re-renders. Consumers with a
 * deadline (planning watchdog) check recency when their timer fires and
 * re-arm for the remainder instead of subscribing.
 */

const lastChannelActivityBySession = new Map<string, number>();

/** Stamp channel activity for a session. Called once per received event. */
export function noteSessionChannelActivity(
  sessionId: string,
  now: number = Date.now()
): void {
  lastChannelActivityBySession.set(sessionId, now);
}

/**
 * Milliseconds since the last channel event for the session, or `null` when
 * no event has been observed since app start (cold session, never subscribed).
 */
export function msSinceSessionChannelActivity(
  sessionId: string,
  now: number = Date.now()
): number | null {
  const last = lastChannelActivityBySession.get(sessionId);
  return last === undefined ? null : Math.max(0, now - last);
}

/** Test-only reset so specs don't leak activity across cases. */
export function clearSessionChannelActivity(sessionId?: string): void {
  if (sessionId === undefined) {
    lastChannelActivityBySession.clear();
    return;
  }
  lastChannelActivityBySession.delete(sessionId);
}
