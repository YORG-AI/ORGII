const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** Compact card timestamp. Anything updated within five minutes reads Now. */
export function formatTaskCardLastUpdated(
  timestamp: string | undefined,
  nowMs: number = Date.now()
): string {
  if (!timestamp) return "";
  const updatedMs = Date.parse(timestamp);
  if (!Number.isFinite(updatedMs)) return "";
  const elapsedMs = Math.max(0, nowMs - updatedMs);

  if (elapsedMs < 5 * MINUTE_MS) return "Now";
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h`;
  if (elapsedMs < WEEK_MS) return `${Math.floor(elapsedMs / DAY_MS)}d`;
  if (elapsedMs < MONTH_MS) return `${Math.floor(elapsedMs / WEEK_MS)}w`;
  if (elapsedMs < YEAR_MS) return `${Math.floor(elapsedMs / MONTH_MS)}mo`;
  return `${Math.floor(elapsedMs / YEAR_MS)}y`;
}
