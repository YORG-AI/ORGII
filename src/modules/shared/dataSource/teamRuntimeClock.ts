import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

interface TeamRuntimeClockSource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function currentMinute(now = Date.now()): number {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS;
}

/**
 * Own one minute-aligned clock for the mounted runtime panel. Hidden documents
 * do no periodic work; returning visible catches up immediately. Recursive
 * timeouts avoid interval overlap and are always released on disposal.
 */
export function startTeamRuntimeClock(
  source: TeamRuntimeClockSource,
  onTick: (nowMs: number) => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (disposed || source.visibilityState === "hidden") return;
    const now = Date.now();
    const delay = MINUTE_MS - (now % MINUTE_MS);
    timer = setTimeout(() => {
      timer = undefined;
      onTick(currentMinute());
      schedule();
    }, delay);
  };
  const handleVisibilityChange = () => {
    clearTimer();
    if (source.visibilityState === "hidden") return;
    onTick(currentMinute());
    schedule();
  };

  source.addEventListener("visibilitychange", handleVisibilityChange);
  schedule();
  return () => {
    disposed = true;
    clearTimer();
    source.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

export function useTeamRuntimeClock(): number {
  const [nowMs, setNowMs] = useState(currentMinute);
  useEffect(() => startTeamRuntimeClock(document, setNowMs), []);
  return nowMs;
}
