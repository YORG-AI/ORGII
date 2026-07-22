interface PollingVisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Start one non-overlapping poll loop. Hidden documents do no periodic work;
 * returning visible performs one immediate refresh before resuming the loop.
 */
export function startVisibilityAwarePoller(
  source: PollingVisibilitySource,
  poll: () => Promise<void>,
  intervalMs: number
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let inFlight = false;
  let rerunAfterFlight = false;
  const isHidden = () => source.visibilityState === "hidden";

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (disposed || inFlight || isHidden()) {
      return;
    }

    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, intervalMs);
  };

  const run = async () => {
    if (disposed || isHidden()) return;
    if (inFlight) {
      rerunAfterFlight = true;
      return;
    }

    clearTimer();
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
      if (!disposed && !isHidden()) {
        if (rerunAfterFlight) {
          rerunAfterFlight = false;
          void run();
        } else {
          schedule();
        }
      }
    }
  };

  const handleVisibilityChange = () => {
    clearTimer();
    if (isHidden()) {
      rerunAfterFlight = false;
      return;
    }
    void run();
  };

  source.addEventListener("visibilitychange", handleVisibilityChange);
  if (!isHidden()) {
    void run();
  }

  return () => {
    disposed = true;
    rerunAfterFlight = false;
    clearTimer();
    source.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
