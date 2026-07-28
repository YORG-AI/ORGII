import { useEffect, useState } from "react";

const KANBAN_NOW_TICK_INTERVAL_MS = 30_000;

interface KanbanVisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Own one non-overlapping Kanban clock. Hidden documents do no periodic work;
 * returning visible refreshes immediately and starts one new timeout.
 */
export function startKanbanNowClock(
  source: KanbanVisibilitySource,
  onTick: (now: number) => void,
  intervalMs = KANBAN_NOW_TICK_INTERVAL_MS
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (disposed || source.visibilityState === "hidden") return;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      onTick(Date.now());
      schedule();
    }, intervalMs);
  };
  const handleVisibilityChange = () => {
    clearTimer();
    if (source.visibilityState === "hidden") return;
    onTick(Date.now());
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

export function useKanbanNowTick(): number {
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => startKanbanNowClock(document, setNowTick), []);
  return nowTick;
}
