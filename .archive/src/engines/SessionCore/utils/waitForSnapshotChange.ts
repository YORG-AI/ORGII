/**
 * waitForSnapshotChange
 *
 * Waits for the next `es:changed` snapshot to arrive for a specific session
 * from `EventStoreProxy`, with a hard timeout. Resolves once a matching
 * snapshot is observed OR when the timeout fires — whichever comes first.
 *
 * # Why this exists
 *
 * Several flows need to coordinate "Rust write succeeded → snapshot will
 * arrive on the next macrotask, but it hasn't yet". The naive pattern
 * directly inside the call site has historically been:
 *
 * ```ts
 * await new Promise<void>((resolve) => {
 *   const timer = setTimeout(resolve, 2000);
 *   const unsub = proxy.subscribe((_, sid) => {
 *     if (sid === sessionId) {
 *       clearTimeout(timer);
 *       unsub();    // <-- only runs on the match path
 *       resolve();
 *     }
 *   });
 * });
 * ```
 *
 * That pattern has two real bugs:
 *
 *   1. **Listener leak on timeout** — when the timer fires first, `unsub`
 *      is never called. The global `EventStoreProxy` listener set
 *      accumulates one ghost listener every time the user switches a
 *      branch (or any other caller times out). On a long-running
 *      session this is a permanent memory leak AND a CPU leak (every
 *      snapshot fan-out walks dead listeners).
 *
 *   2. **Race window** — the Rust side can emit the matching snapshot
 *      between the moment the caller decided to wait and the moment
 *      `subscribe(...)` actually registers. The default behavior of the
 *      naive code is "wait the full timeout". We can't fix the race
 *      perfectly inside the callback (snapshot emission is not
 *      synchronous with the awaiting code), but we CAN short-circuit
 *      when the latest cached snapshot for the session was already
 *      observed AFTER the caller decided to wait.
 *
 * # Behavior
 *
 * - Resolves with `"snapshot"` if a matching `es:changed` snapshot is
 *   observed before the timeout.
 * - Resolves with `"timeout"` otherwise.
 * - ALWAYS unsubscribes the listener and clears the timer (try/finally
 *   semantics emulated with a small closure-scoped `cleanup` callback).
 * - Supports an optional `predicate` so callers can require more than
 *   "any snapshot for this session" (e.g. "snapshot whose version is
 *   strictly greater than X").
 *
 * # Optional "already-changed" short-circuit
 *
 * If a caller passes `lastKnownVersion`, the helper compares it against
 * the latest cached snapshot for the session BEFORE installing the
 * listener. When the cached snapshot has already advanced past
 * `lastKnownVersion`, the helper resolves with `"snapshot"` immediately
 * — no listener install, no timer set.
 *
 * @see UserChatItem.tsx BranchNavigator.switchTo
 * @see useEditUserMessage truncation flow
 */
import type { Snapshot, SnapshotEnvelope } from "../core/store/EventStoreProxy";

// Minimal interface so this helper can be unit tested without pulling in
// the full Tauri-dependent EventStoreProxy. Production code passes the
// real `eventStoreProxy` singleton, but vitest passes a tiny fake.
export interface SnapshotSubscriber {
  subscribe(
    listener: (snapshot: Snapshot, sessionId: string) => void
  ): () => void;
  getLatestSessionSnapshot(sessionId: string): Snapshot | null;
}

export type WaitForSnapshotChangeOutcome = "snapshot" | "timeout";

export interface WaitForSnapshotChangeOptions {
  /** Session id to wait for. */
  sessionId: string;
  /** Max time to wait in ms. Hard upper bound — never extended. */
  timeoutMs: number;
  /**
   * Optional version watermark. When provided, the helper resolves
   * immediately if the latest cached snapshot for `sessionId` already
   * has a version strictly greater than `lastKnownVersion`. Used by
   * callers that want "wait for the NEXT snapshot" semantics in cases
   * where the snapshot may have already arrived between deciding to
   * wait and registering the listener.
   */
  lastKnownVersion?: number;
  /**
   * Optional additional predicate. If supplied, only snapshots that
   * BOTH match `sessionId` AND return `true` from this callback count
   * as a successful resolve. Useful for "wait for a snapshot whose
   * eventCount is >= N" or similar fine-grained conditions.
   */
  predicate?: (snapshot: Snapshot) => boolean;
  /**
   * Optional abort signal. When the signal fires before resolution
   * the helper resolves with `"timeout"` and releases the listener.
   * Used by callers that need to cancel the wait on unmount or
   * session switch.
   */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Wait for the next `es:changed` snapshot to arrive for `sessionId`.
 *
 * Resolves with `"snapshot"` on a successful match or `"timeout"` when
 * either the hard deadline elapses or the (optional) signal aborts.
 *
 * Importantly, this function always cleans up both the listener and the
 * timer, regardless of which path resolves first. The previous inline
 * pattern in `BranchNavigator.switchTo` leaked the subscriber on the
 * timeout path, which is the bug this helper exists to prevent
 * structurally rather than via discipline.
 */
export function waitForSnapshotChange(
  store: SnapshotSubscriber,
  options: WaitForSnapshotChangeOptions
): Promise<WaitForSnapshotChangeOutcome> {
  const {
    sessionId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    lastKnownVersion,
    predicate,
    signal,
  } = options;

  // Short-circuit when the snapshot already advanced past the
  // watermark. This avoids the case where Rust emitted the snapshot
  // BEFORE the caller awaited this helper.
  if (typeof lastKnownVersion === "number") {
    const latest = store.getLatestSessionSnapshot(sessionId);
    if (
      latest &&
      latest.version > lastKnownVersion &&
      (!predicate || predicate(latest))
    ) {
      return Promise.resolve("snapshot");
    }
  }

  // If the signal is already aborted at call time, return immediately.
  if (signal?.aborted) {
    return Promise.resolve("timeout");
  }

  return new Promise<WaitForSnapshotChangeOutcome>((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub !== null) {
        try {
          unsub();
        } catch {
          // Best-effort cleanup; never let unsub errors swallow resolution.
        }
        unsub = null;
      }
      if (abortHandler !== null && signal) {
        signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
    };

    const settle = (outcome: WaitForSnapshotChangeOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    timer = setTimeout(() => settle("timeout"), timeoutMs);

    unsub = store.subscribe((snapshot, snapshotSessionId) => {
      if (snapshotSessionId !== sessionId) return;
      if (predicate && !predicate(snapshot)) return;
      settle("snapshot");
    });

    if (signal) {
      abortHandler = () => settle("timeout");
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

/**
 * Type-guard helper used by callers that need to narrow a snapshot
 * envelope back to a per-session shape before passing it to
 * `waitForSnapshotChange`. Kept here so the helper module is the single
 * place that knows about the envelope quirks.
 */
export function isEnvelopeForSession(
  envelope: SnapshotEnvelope,
  sessionId: string
): boolean {
  return envelope.sessionId === sessionId;
}
