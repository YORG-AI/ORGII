/**
 * createPillCache
 *
 * Generic factory for module-level, app-wide pill caches. Both
 * `cursorModelCache` and `cursorModeCache` share identical boilerplate:
 *   - module-level mutable state record
 *   - Set<Listener> fan-out
 *   - in-flight promise deduplication
 *   - TTL-gated freshness check
 *   - notify / setState helpers
 *   - subscribe / getState / fetch / resetForTests exports
 *
 * This factory owns that skeleton once. Each cache passes:
 *   - `initialState`  — the zero value for its state shape
 *   - `ttlMs`         — how long a successful fetch stays fresh
 *   - `doFetch`       — async function that returns a state *patch*
 *
 * The returned object exposes the same API surface that the old files
 * exported individually, so callers (useCursorModels, useCursorModes)
 * work without changes.
 */

export interface PillCacheOptions<S extends object> {
  /** Zero-value for the state record. */
  initialState: S;
  /** Re-fetch after this many milliseconds since last success. */
  ttlMs: number;
  /**
   * Perform the actual backend call(s).
   * Return a partial patch that will be merged into state.
   * The factory handles setting `loading`, `error`, and `fetchedAt`.
   */
  doFetch: () => Promise<Partial<S>>;
}

export interface PillCacheModule<S extends object> {
  getState: () => S;
  subscribe: (listener: (state: S) => void) => () => void;
  fetch: (options?: { force?: boolean }) => Promise<void>;
  resetForTests: () => void;
}

/** Fields the factory manages automatically — callers must include them in S. */
export interface PillCacheBaseFields {
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

export function createPillCache<S extends PillCacheBaseFields>(
  opts: PillCacheOptions<S>
): PillCacheModule<S> {
  type Listener = (state: S) => void;

  let state: S = { ...opts.initialState };
  const listeners = new Set<Listener>();
  let inflight: Promise<void> | null = null;

  function notify(): void {
    for (const listener of listeners) {
      listener(state);
    }
  }

  function setState(patch: Partial<S>): void {
    state = { ...state, ...patch };
    notify();
  }

  function getState(): S {
    return state;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function fetch(options: { force?: boolean } = {}): Promise<void> {
    const { force = false } = options;

    const isFresh =
      state.fetchedAt !== null &&
      state.error === null &&
      Date.now() - state.fetchedAt < opts.ttlMs;

    if (!force && isFresh) return;

    // Non-forced calls coalesce; forced calls start a fresh request.
    if (inflight && !force) return inflight;

    setState({ loading: true, error: null } as Partial<S>);

    inflight = (async () => {
      try {
        const patch = await opts.doFetch();
        setState({
          ...patch,
          loading: false,
          error: null,
          fetchedAt: Date.now(),
        } as Partial<S>);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        setState({ loading: false, error: reason } as Partial<S>);
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  function resetForTests(): void {
    state = { ...opts.initialState };
    inflight = null;
    notify();
  }

  return { getState, subscribe, fetch, resetForTests };
}
