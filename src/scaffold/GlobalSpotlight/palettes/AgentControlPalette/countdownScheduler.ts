export function getCountdownRemaining(
  expiresAt: number,
  now: () => number = Date.now
): number {
  return Math.max(0, expiresAt - now());
}

/**
 * Owns the proposal countdown's single timer and visibility listener.
 *
 * The UI label only changes once per second, so frame-rate updates would
 * needlessly re-render the full proposal creator. Hidden windows keep no timer;
 * returning to the foreground recalculates from the absolute expiry time.
 */
export class CountdownScheduler {
  private timeoutId: number | undefined;
  private running = false;

  constructor(
    private readonly expiresAt: number,
    private readonly onUpdate: (remaining: number) => void,
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    this.stop();
    this.running = true;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.updateAndSchedule();
  }

  stop(): void {
    this.running = false;
    this.clearScheduledUpdate();
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
  }

  private clearScheduledUpdate(): void {
    if (this.timeoutId === undefined) return;
    window.clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
  }

  private updateAndSchedule = (): void => {
    this.clearScheduledUpdate();
    if (!this.running) return;

    const remaining = getCountdownRemaining(this.expiresAt, this.now);
    this.onUpdate(remaining);
    if (remaining > 0 && document.visibilityState !== "hidden") {
      this.timeoutId = window.setTimeout(
        this.updateAndSchedule,
        Math.min(1000, remaining)
      );
    }
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.clearScheduledUpdate();
      return;
    }
    this.updateAndSchedule();
  };
}
