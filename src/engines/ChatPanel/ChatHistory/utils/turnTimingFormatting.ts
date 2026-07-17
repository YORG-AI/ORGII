export interface TurnTimingLabels {
  duration: string;
  startClock: string;
  endClock: string;
  showRange: boolean;
}

/**
 * Compact spoken duration: `5m 5s`, `5m`, or `42s`. Missing/zero durations
 * (e.g. imported transcripts that carry no timestamps) read as `<1min`
 * rather than a broken-looking `0s`.
 */
export function formatTurnDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "<1min";
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds === 0) return "<1min";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Locale-aware 24-hour wall-clock label used by turn summaries. */
export function formatTurnClockTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

export function getTurnTimingLabels(
  durationMs: number,
  startMs: number | null,
  endMs: number | null
): TurnTimingLabels {
  const startClock = startMs !== null ? formatTurnClockTime(startMs) : "";
  const endClock = endMs !== null ? formatTurnClockTime(endMs) : "";
  return {
    duration: formatTurnDuration(durationMs),
    startClock,
    endClock,
    showRange:
      startClock !== "" &&
      endClock !== "" &&
      startMs !== null &&
      endMs !== null &&
      endMs - startMs >= 1000,
  };
}
