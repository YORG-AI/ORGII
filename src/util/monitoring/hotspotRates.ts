const ONE_MINUTE_MS = 60_000;

/** Average event rate across the full observation window shown by DevTools. */
export function ratePerMinuteInWindow(
  eventCount: number,
  windowMs: number
): number {
  if (eventCount <= 0 || windowMs <= 0) return 0;
  return eventCount * (ONE_MINUTE_MS / windowMs);
}

/** A simultaneous fan-out batch is not, by itself, a polling loop. */
export function spansRepeatedActivity(
  firstTimestampMs: number,
  lastTimestampMs: number,
  minimumSpanMs = 1_000
): boolean {
  return lastTimestampMs - firstTimestampMs >= minimumSpanMs;
}
