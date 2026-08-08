/**
 * SUBSCRIBED-edge recovery policy for the Realtime planes.
 *
 * Every (re)subscribe true-edge must compensate for events missed while
 * disconnected, but a FULL recovery (complete listings + entitlement refresh)
 * is only warranted when the gap could hide tombstone-free absences. Short
 * gaps are covered by the delta cursors (session listing merges `deletedAt`
 * tombstones; collab-state pulls return LWW tombstones), and a flaky network
 * re-joining every few seconds must not replay the heaviest listings on each
 * edge.
 */

/** Disconnected longer than this ⇒ the next edge performs a full recovery. */
export const FULL_RECOVERY_DISCONNECT_MS = 5 * 60_000;

/** Repeated edges within this window downgrade to delta (rejoin storms). */
export const FULL_RECOVERY_COOLDOWN_MS = 30_000;

/** Focus/visible-edge refetches share the same flap discipline: one full
 * refresh per window, however fast the user alt-tabs. */
export const FOCUS_REFRESH_COOLDOWN_MS = 30_000;

export interface SubscribedEdgeRecoveryInput {
  nowMs: number;
  /** When this org's channels were last torn down; undefined = never seen. */
  teardownAtMs: number | undefined;
  /** When this org last ran a full recovery; undefined = never. */
  lastFullRecoveryAtMs: number | undefined;
}

export function decideSubscribedEdgeRecovery({
  nowMs,
  teardownAtMs,
  lastFullRecoveryAtMs,
}: SubscribedEdgeRecoveryInput): "full" | "delta" {
  if (
    lastFullRecoveryAtMs !== undefined &&
    nowMs - lastFullRecoveryAtMs < FULL_RECOVERY_COOLDOWN_MS
  ) {
    return "delta";
  }
  if (
    teardownAtMs !== undefined &&
    nowMs - teardownAtMs < FULL_RECOVERY_DISCONNECT_MS
  ) {
    return "delta";
  }
  return "full";
}
