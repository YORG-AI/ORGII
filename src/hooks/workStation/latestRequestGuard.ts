export interface LatestRequestTicket {
  /** True only while no newer request or explicit invalidation has occurred. */
  isCurrent(): boolean;
}

/**
 * Coordinates async work where only the latest request may update UI state.
 *
 * The underlying operation does not need cancellation support: callers issue a
 * ticket before awaiting, then guard every success, error, and loading-state
 * write with `ticket.isCurrent()`. `invalidate()` also makes in-flight tickets
 * stale when the owning consumer resets or unmounts.
 */
export class LatestRequestGuard {
  private generation = 0;

  issue(): LatestRequestTicket {
    const generation = ++this.generation;
    return {
      isCurrent: () => this.generation === generation,
    };
  }

  invalidate(): void {
    this.generation += 1;
  }
}
