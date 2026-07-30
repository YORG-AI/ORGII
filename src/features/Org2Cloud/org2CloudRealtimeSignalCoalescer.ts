/**
 * A short leading/trailing window for server-pushed invalidations.
 *
 * The backend already collapses each org's durable change signal. This
 * client-side window only absorbs the remaining transaction burst; it must
 * stay below a human-visible notification delay.
 */
export const REALTIME_SIGNAL_COALESCE_MS = 750;

interface TimerHost {
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const defaultTimerHost: TimerHost = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Coalesces bursty push invalidations per fixed plane. There is no recurring
 * timer: a plane is idle until a server signal schedules work.
 */
export class Org2CloudRealtimeSignalCoalescer<Plane> {
  private readonly handledAt = new Map<Plane, number>();
  private readonly trailingTimers = new Map<
    Plane,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly windowMs = REALTIME_SIGNAL_COALESCE_MS,
    private readonly timers: TimerHost = defaultTimerHost
  ) {}

  markHandled(planes: Iterable<Plane>): void {
    const now = this.timers.now();
    for (const plane of planes) this.handledAt.set(plane, now);
  }

  schedule(plane: Plane, refresh: () => void): void {
    const now = this.timers.now();
    const lastHandledAt = this.handledAt.get(plane);
    const elapsed =
      lastHandledAt === undefined ? this.windowMs : now - lastHandledAt;
    const run = () => {
      this.handledAt.set(plane, this.timers.now());
      refresh();
    };
    if (elapsed >= this.windowMs) {
      run();
      return;
    }
    if (this.trailingTimers.has(plane)) return;
    this.trailingTimers.set(
      plane,
      this.timers.setTimeout(() => {
        this.trailingTimers.delete(plane);
        run();
      }, this.windowMs - elapsed)
    );
  }

  reset(): void {
    for (const timer of this.trailingTimers.values()) {
      this.timers.clearTimeout(timer);
    }
    this.trailingTimers.clear();
    this.handledAt.clear();
  }
}
