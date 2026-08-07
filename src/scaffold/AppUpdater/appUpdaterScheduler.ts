export type AutomaticUpdateReason =
  | "startup"
  | "interval"
  | "foreground"
  | "online";

interface AppUpdaterSchedulerOptions {
  startupDelayMs: number | null;
  intervalMs: number;
  foregroundDebounceMs: number;
}

/** Browser-event scheduler with a single debounced foreground path. */
export class AppUpdaterScheduler {
  private startupTimer: number | null = null;
  private intervalTimer: number | null = null;
  private foregroundTimer: number | null = null;
  private onCheck: ((reason: AutomaticUpdateReason) => void) | null = null;

  constructor(private readonly options: AppUpdaterSchedulerOptions) {}

  start(onCheck: (reason: AutomaticUpdateReason) => void): void {
    this.stop();
    this.onCheck = onCheck;
    if (this.options.startupDelayMs !== null) {
      this.startupTimer = window.setTimeout(
        () => onCheck("startup"),
        this.options.startupDelayMs
      );
    }
    this.intervalTimer = window.setInterval(
      () => onCheck("interval"),
      this.options.intervalMs
    );
    window.addEventListener("focus", this.handleFocus);
    window.addEventListener("online", this.handleOnline);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  stop(): void {
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    if (this.intervalTimer !== null) window.clearInterval(this.intervalTimer);
    if (this.foregroundTimer !== null) {
      window.clearTimeout(this.foregroundTimer);
    }
    this.startupTimer = null;
    this.intervalTimer = null;
    this.foregroundTimer = null;
    window.removeEventListener("focus", this.handleFocus);
    window.removeEventListener("online", this.handleOnline);
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
    this.onCheck = null;
  }

  private scheduleForegroundCheck(reason: "foreground" | "online"): void {
    if (!this.onCheck || document.visibilityState !== "visible") return;
    if (this.foregroundTimer !== null) {
      window.clearTimeout(this.foregroundTimer);
    }
    this.foregroundTimer = window.setTimeout(() => {
      this.foregroundTimer = null;
      this.onCheck?.(reason);
    }, this.options.foregroundDebounceMs);
  }

  private handleFocus = (): void => {
    this.scheduleForegroundCheck("foreground");
  };

  private handleOnline = (): void => {
    this.scheduleForegroundCheck("online");
  };

  private handleVisibilityChange = (): void => {
    this.scheduleForegroundCheck("foreground");
  };
}
