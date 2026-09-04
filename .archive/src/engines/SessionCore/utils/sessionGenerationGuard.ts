/**
 * sessionGenerationGuard
 *
 * Tiny reusable utility for "abandon stale async work when the user
 * switches sessions" race protection.
 *
 * # The problem
 *
 * Several session-scoped flows look like this:
 *
 * ```ts
 * function loadOrRestoreSomething(sessionId: string) {
 *   doExpensiveAsyncWork(sessionId).then((result) => {
 *     writeIntoAtoms(sessionId, result); // <-- can stomp newer state
 *   });
 * }
 * ```
 *
 * If the user rapidly switches A → B → A, the **older** invocation
 * for A may resolve **after** the newer one and overwrite the freshly
 * settled atom state with stale data. Examples in this codebase:
 *
 * - `useHostedKeyActivitySync.refreshCursor`: in-flight cursor reads
 *   for an old session id could resolve into the new session's
 *   dedup window.
 * - `useSessionSync`'s `doSwitch`: handled via AbortController, but
 *   that pattern requires the async operation to actually check the
 *   signal, which not every call site does.
 *
 * # The shape of the fix
 *
 * Maintain a per-key generation counter. Before kicking off the async
 * work, snapshot the current generation; when results arrive, check
 * the snapshot against the live counter. If the live counter has
 * advanced, abandon — a newer invocation has superseded us.
 *
 * Generations are per-key (typically `sessionId`) so concurrent work
 * on different sessions doesn't fight: A's work is only invalidated
 * by a newer A invocation, not by a B invocation.
 *
 * # Why a class, not a plain object
 *
 * - Encapsulates the Map and an `isDisposed` flag so callers can't
 *   accidentally bypass invalidation.
 * - `dispose()` marks every in-flight check as stale, which is what
 *   you want from a React effect cleanup.
 */

export interface GenerationTicket {
  /** True iff this ticket is the most recent for its key AND the guard hasn't been disposed. */
  isCurrent(): boolean;
  /** True iff this ticket has been superseded OR the guard is disposed. */
  isStale(): boolean;
  /** The key this ticket was issued for. */
  readonly key: string;
  /** The generation number at issue time. */
  readonly generation: number;
}

export class SessionGenerationGuard {
  private readonly generations = new Map<string, number>();
  private disposed = false;

  /**
   * Mint a new ticket for `key`. The returned ticket starts as
   * "current" — `isCurrent()` returns `true` until another call to
   * `issue(key)` advances the generation for the SAME key, or until
   * `dispose()` is called.
   *
   * Callers should snapshot the ticket BEFORE awaiting any async
   * work, then call `ticket.isCurrent()` (or `isStale()`) when the
   * await resolves.
   */
  issue(key: string): GenerationTicket {
    if (this.disposed) {
      // Issuing a ticket against a disposed guard should still produce
      // a ticket, but one that's immediately stale. This keeps caller
      // logic uniform — they don't have to special-case "guard was
      // disposed before I even started" vs "guard was disposed while
      // I was waiting".
      return {
        key,
        generation: -1,
        isCurrent: () => false,
        isStale: () => true,
      };
    }
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    const captured = next;
    // Capture `disposed` and `generations` via the arrow closures
    // below instead of aliasing `this`. The class fields are mutated
    // in place (not reassigned) so the closures always see the live
    // values without needing a stored `this` reference.
    const isCurrent = (): boolean =>
      !this.disposed && this.generations.get(key) === captured;
    const isStale = (): boolean =>
      this.disposed || this.generations.get(key) !== captured;
    return {
      key,
      generation: captured,
      isCurrent,
      isStale,
    };
  }

  /**
   * Mark every in-flight ticket as stale. Call this in React effect
   * cleanup (e.g. on unmount or before a fresh subscribe). After
   * disposal, every ticket — old AND newly-issued — reports
   * `isStale === true`, so background tasks can safely no-op without
   * having to track unmount state independently.
   *
   * Disposal is idempotent.
   */
  dispose(): void {
    this.disposed = true;
    this.generations.clear();
  }

  /**
   * Whether `dispose()` has been called. Exposed for diagnostics
   * and for callers that want to assert in tests.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Read the current generation for `key`. Mostly useful for tests
   * and for log instrumentation — production code should use
   * `issue()` / `ticket.isCurrent()` instead, which capture the
   * generation atomically.
   */
  peek(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  /**
   * Number of distinct keys currently tracked. Exposed for tests
   * and for diagnostics (e.g. to detect a runaway hook issuing
   * tickets for thousands of session ids).
   */
  size(): number {
    return this.generations.size;
  }

  /**
   * Forget the bookkeeping for a single key. Optional: callers that
   * know a session is permanently closed can prune so the map
   * doesn't grow indefinitely.
   *
   * NOTE: forgetting a key means the NEXT `issue(key)` resets the
   * generation back to 1. Any tickets from prior issues are
   * immediately stale, which is the safe behavior.
   */
  forget(key: string): void {
    this.generations.delete(key);
  }
}

/**
 * Module-level singleton convenience. Most call sites should NOT use
 * this — they should construct their own guard per hook instance so
 * disposal is scoped to that instance. The singleton exists only for
 * call sites where global "the user switched sessions" semantics are
 * what's wanted (which is rare).
 */
export const globalSessionGenerationGuard = new SessionGenerationGuard();
