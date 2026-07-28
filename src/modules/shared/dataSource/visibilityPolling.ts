interface VisibilityPollingSource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Own one non-overlapping visibility-aware polling timer.
 *
 * The poll callback owns error reporting; this coordinator always rearms after
 * settlement while visible and suppresses late rearming after disposal.
 */
export function startVisibilityAwarePolling(
  source: VisibilityPollingSource,
  poll: () => Promise<void>,
  intervalMs: number
): () => void {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timeoutId === undefined) return;
    clearTimeout(timeoutId);
    timeoutId = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (stopped || source.visibilityState === "hidden") return;
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      runPoll();
    }, intervalMs);
  };
  const runPoll = () => {
    void Promise.resolve()
      .then(poll)
      .finally(schedule)
      .catch(() => {
        // The callback owns error presentation; keep the polling chain alive.
      });
  };
  const onVisibilityChange = () => {
    clearTimer();
    if (source.visibilityState !== "hidden") runPoll();
  };

  source.addEventListener("visibilitychange", onVisibilityChange);
  schedule();
  return () => {
    stopped = true;
    clearTimer();
    source.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
