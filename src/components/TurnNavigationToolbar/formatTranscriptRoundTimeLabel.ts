const MIN_TIME_RANGE_MS = 60_000;

function formatClockTime(ms: number): string {
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

function formatClockRange(startMs: number, endMs: number): string {
  const startClock = formatClockTime(startMs);
  if (!startClock) return "";
  if (endMs - startMs < MIN_TIME_RANGE_MS) return startClock;

  const endClock = formatClockTime(endMs);
  if (!endClock) return "";

  return `${startClock} ~ ${endClock}`;
}

export function formatTranscriptRoundTimeLabel(round: {
  startedAt?: string;
  endedAt?: string | null;
}): string {
  if (!round.startedAt) return "";
  const startMs = Date.parse(round.startedAt);
  const endMs = round.endedAt ? Date.parse(round.endedAt) : startMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "";
  return formatClockRange(startMs, endMs);
}
