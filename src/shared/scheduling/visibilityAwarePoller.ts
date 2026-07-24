export interface PollingVisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  hasFocus?(): boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PollingFocusSource {
  addEventListener(type: "focus" | "blur", listener: () => void): void;
  removeEventListener(type: "focus" | "blur", listener: () => void): void;
}

export type VisibilityAwarePollerOptions =
  | {
      pauseWhenUnfocused?: false;
      focusSource?: never;
    }
  | {
      /**
       * Pause while the owning window is unfocused. This is opt-in because
       * some visible side-by-side surfaces still need their normal cadence.
       */
      pauseWhenUnfocused: true;
      focusSource: PollingFocusSource;
    };

/**
 * Start one non-overlapping poll loop. Hidden documents do no periodic work;
 * returning visible performs one immediate refresh before resuming the loop.
 * Callers may also opt into pausing while the owning window is unfocused,
 * which covers minimized Tauri WebView2 windows that remain `visible`.
 */
export function startVisibilityAwarePoller(
  source: PollingVisibilitySource,
  poll: () => Promise<void>,
  intervalMs: number,
  options: VisibilityAwarePollerOptions = {}
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let inFlight = false;
  let rerunAfterFlight = false;
  const isHidden = () => source.visibilityState === "hidden";
  const isUnfocused = () =>
    options.pauseWhenUnfocused === true &&
    typeof source.hasFocus === "function" &&
    !source.hasFocus();
  const isInactive = () => isHidden() || isUnfocused();
  let wasInactive = isInactive();

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (disposed || inFlight || isInactive()) {
      return;
    }

    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, intervalMs);
  };

  const run = async () => {
    if (disposed || isInactive()) return;
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
      if (!disposed && !isInactive()) {
        if (rerunAfterFlight) {
          rerunAfterFlight = false;
          void run();
        } else {
          schedule();
        }
      }
    }
  };

  const handleActivityChange = () => {
    const inactive = isInactive();
    if (inactive === wasInactive) return;
    wasInactive = inactive;
    clearTimer();
    if (inactive) {
      rerunAfterFlight = false;
      return;
    }
    void run();
  };

  source.addEventListener("visibilitychange", handleActivityChange);
  if (options.pauseWhenUnfocused && options.focusSource) {
    options.focusSource.addEventListener("focus", handleActivityChange);
    options.focusSource.addEventListener("blur", handleActivityChange);
  }
  if (!wasInactive) {
    void run();
  }

  return () => {
    disposed = true;
    rerunAfterFlight = false;
    clearTimer();
    source.removeEventListener("visibilitychange", handleActivityChange);
    if (options.pauseWhenUnfocused && options.focusSource) {
      options.focusSource.removeEventListener("focus", handleActivityChange);
      options.focusSource.removeEventListener("blur", handleActivityChange);
    }
  };
}
