import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

const MINUTE_MS = 60_000;

/** Compact card timestamp. Anything updated within five minutes reads as current. */
export function formatTaskCardLastUpdated(
  timestamp: string | undefined,
  nowMs: number = Date.now()
): string {
  if (!timestamp) return "";
  const updatedMs = Date.parse(timestamp);
  if (!Number.isFinite(updatedMs)) return "";
  const elapsedMs = Math.max(0, nowMs - updatedMs);

  return formatRelativeTime(
    elapsedMs < 5 * MINUTE_MS ? nowMs : updatedMs,
    "nano",
    undefined,
    nowMs
  );
}
