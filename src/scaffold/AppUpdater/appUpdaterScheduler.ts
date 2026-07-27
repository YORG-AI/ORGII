export type AutomaticUpdateReason =
  | "startup"
  | "interval"
  | "foreground"
  | "online"
  | "retry";

interface AppUpdaterSchedulerOptions {
  startupDelayMs: number | null;
  intervalMs: number;
  foregroundDebounceMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterRatio?: number;
  now?: () => number;
  random?: () => number;
}

/**
 * Visibility-aware browser scheduler for automatic update work.
 *
 * It owns exactly one timer for each trigger class. Retry failures use capped
 * exponential backoff with jitter, and focus/online events cannot bypass an
 * active retry cooldown.
 */
export class AppUpdaterScheduler {
  private startupTimer: number | null = null;
  private intervalTimer: number | null = null;
  private foregroundTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryAttempt = 0;
  private retryDueAt: number | null = null;
  private pendingCheck: Promise<void> | null = null;
  private generation = 0;
  private onCheck:
    | ((reason: AutomaticUpdateReason) => void | Promise<void>)
    | null = null;

  constructor(private readonly options: AppUpdaterSchedulerOptions) {}

  start(
    onCheck: (reason: AutomaticUpdateReason) => void | Promise<void>
  ): void {
    this.stop();
    this.onCheck = onCheck;
    window.addEventListener("focus", this.handleFocus);
    window.addEventListener("online", this.handleOnline);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    if (this.isVisible() && this.options.startupDelayMs !== null) {
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = null;
        this.triggerCheck("startup");
      }, this.options.startupDelayMs);
    }
    this.scheduleInterval();
  }

  stop(): void {
    this.generation += 1;
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    if (this.intervalTimer !== null) window.clearTimeout(this.intervalTimer);
    if (this.foregroundTimer !== null) {
      window.clearTimeout(this.foregroundTimer);
    }
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
    this.foregroundTimer = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.retryDueAt = null;
    this.pendingCheck = null;
    window.removeEventListener("focus", this.handleFocus);
    window.removeEventListener("online", this.handleOnline);
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
    this.onCheck = null;
  }

  private scheduleRetry(): void {
    if (!this.onCheck) return;
    if (this.retryDueAt !== null) {
      return;
    }

    const exponentialDelay = Math.min(
      this.options.retryMaxDelayMs,
      this.options.retryBaseDelayMs * 2 ** Math.min(this.retryAttempt, 30)
    );
    const jitterRatio = Math.min(
      0.5,
      Math.max(0, this.options.retryJitterRatio ?? 0.2)
    );
    const jitterMultiplier = 1 - jitterRatio + 2 * jitterRatio * this.random();
    const delay = Math.min(
      this.options.retryMaxDelayMs,
      Math.max(0, Math.round(exponentialDelay * jitterMultiplier))
    );

    this.retryAttempt += 1;
    this.retryDueAt = this.now() + delay;
    this.armRetryTimer();
  }

  retryNow(): void {
    if (!this.onCheck || this.retryDueAt === null) return;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDueAt = null;
    this.triggerCheck("retry");
  }

  resetRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.retryDueAt = null;
  }

  private scheduleInterval(): void {
    if (!this.onCheck || !this.isVisible() || this.intervalTimer !== null) {
      return;
    }
    this.intervalTimer = window.setTimeout(() => {
      this.intervalTimer = null;
      if (this.isVisible()) this.triggerCheck("interval");
      this.scheduleInterval();
    }, this.options.intervalMs);
  }

  private scheduleForegroundCheck(reason: "foreground" | "online"): void {
    if (!this.onCheck || !this.isVisible()) return;
    if (this.retryDueAt !== null) {
      this.armRetryTimer();
      return;
    }
    if (this.foregroundTimer !== null) {
      window.clearTimeout(this.foregroundTimer);
    }
    this.foregroundTimer = window.setTimeout(() => {
      this.foregroundTimer = null;
      this.triggerCheck(reason);
    }, this.options.foregroundDebounceMs);
  }

  private armRetryTimer(): void {
    if (
      !this.onCheck ||
      this.retryDueAt === null ||
      !this.isVisible() ||
      !this.isOnline()
    ) {
      return;
    }
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    const remainingDelay = Math.max(0, this.retryDueAt - this.now());
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.isVisible() || !this.isOnline()) return;
      this.retryDueAt = null;
      this.triggerCheck("retry");
    }, remainingDelay);
  }

  private triggerCheck(reason: AutomaticUpdateReason): void {
    if (!this.onCheck || this.pendingCheck) return;
    if (reason !== "retry" && this.retryDueAt !== null) return;
    if (!this.isOnline()) {
      this.scheduleRetry();
      return;
    }

    const generation = this.generation;
    const operation = Promise.resolve().then(() => {
      const onCheck = this.onCheck;
      if (onCheck) return onCheck(reason);
    });
    this.pendingCheck = operation;
    void operation.then(
      () => {
        if (generation !== this.generation || this.pendingCheck !== operation) {
          return;
        }
        this.pendingCheck = null;
        this.resetRetry();
      },
      () => {
        if (generation !== this.generation || this.pendingCheck !== operation) {
          return;
        }
        this.pendingCheck = null;
        this.scheduleRetry();
      }
    );
  }

  private pauseHiddenWork(): void {
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    if (this.intervalTimer !== null) window.clearTimeout(this.intervalTimer);
    if (this.foregroundTimer !== null) {
      window.clearTimeout(this.foregroundTimer);
    }
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
    this.foregroundTimer = null;
    this.retryTimer = null;
  }

  private isVisible(): boolean {
    return document.visibilityState === "visible";
  }

  private isOnline(): boolean {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private random(): number {
    return this.options.random?.() ?? Math.random();
  }

  private handleFocus = (): void => {
    this.scheduleForegroundCheck("foreground");
  };

  private handleOnline = (): void => {
    this.scheduleForegroundCheck("online");
  };

  private handleVisibilityChange = (): void => {
    if (!this.isVisible()) {
      this.pauseHiddenWork();
      return;
    }
    this.scheduleInterval();
    this.scheduleForegroundCheck("foreground");
  };
}
