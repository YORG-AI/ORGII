export interface PollEnvironment {
  clearTimer(timer: unknown): void;
  isVisible(): boolean;
  scheduleTimer(callback: () => void, delayMs: number): unknown;
  subscribeToVisibilityChange(callback: () => void): () => void;
}

export interface VisibilityAwarePollOptions {
  environment?: PollEnvironment;
  intervalMs: number;
  onError?: (error: unknown) => void;
  runImmediately?: boolean;
  runOnVisible?: boolean;
  task: () => Promise<void> | void;
}

export interface VisibilityAwarePollController {
  runNow(): void;
  stop(): void;
}

function browserPollEnvironment(): PollEnvironment {
  return {
    clearTimer: (timer) => window.clearTimeout(timer as number),
    isVisible: () => document.visibilityState !== "hidden",
    scheduleTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    subscribeToVisibilityChange: (callback) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
  };
}

/**
 * Run a non-critical background task without overlapping executions.
 *
 * The next delay starts only after the previous task settles. Hidden pages
 * retain no timer; becoming visible triggers one immediate catch-up pass.
 */
export function startVisibilityAwarePoll(
  options: VisibilityAwarePollOptions
): VisibilityAwarePollController {
  const environment = options.environment ?? browserPollEnvironment();
  const runOnVisible = options.runOnVisible ?? true;
  let stopped = false;
  let running = false;
  let rerunRequested = false;
  let timer: unknown;

  const clearScheduledTimer = () => {
    if (timer === undefined) return;
    environment.clearTimer(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (stopped || running || timer !== undefined || !environment.isVisible()) {
      return;
    }
    timer = environment.scheduleTimer(() => {
      timer = undefined;
      void run();
    }, options.intervalMs);
  };

  const run = async () => {
    if (stopped || !environment.isVisible()) return;
    if (running) {
      rerunRequested = true;
      return;
    }

    clearScheduledTimer();
    running = true;
    try {
      await options.task();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      if (!stopped) {
        if (rerunRequested && environment.isVisible()) {
          rerunRequested = false;
          void run();
        } else {
          rerunRequested = false;
          schedule();
        }
      }
    }
  };

  const unsubscribe = environment.subscribeToVisibilityChange(() => {
    if (!environment.isVisible()) {
      clearScheduledTimer();
      return;
    }
    if (runOnVisible) {
      void run();
    } else {
      schedule();
    }
  });

  if (options.runImmediately) {
    void run();
  } else {
    schedule();
  }

  return {
    runNow: () => void run(),
    stop: () => {
      stopped = true;
      rerunRequested = false;
      clearScheduledTimer();
      unsubscribe();
    },
  };
}
