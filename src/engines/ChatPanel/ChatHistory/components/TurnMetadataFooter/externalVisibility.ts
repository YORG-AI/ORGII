export const EXTERNAL_TURN_METADATA_IDLE_GRACE_MS = 10_000;

export function externalTurnMetadataReadyAt(
  lastEventAt: string | null | undefined,
  scanIntervalMs: number
): number | null {
  if (!lastEventAt) return null;
  const lastEventMs = Date.parse(lastEventAt);
  if (!Number.isFinite(lastEventMs)) return null;
  return lastEventMs + scanIntervalMs + EXTERNAL_TURN_METADATA_IDLE_GRACE_MS;
}
