/**
 * In-process fan-out for decoded PTY output.
 *
 * Terminal output reaches the webview over a per-session `Channel` with exactly
 * one receiver — the terminal pane that installed it — so a surface that merely
 * *observes* output cannot listen for the same data a second time. Observers
 * subscribe here instead.
 *
 * The pane publishes text it has already decoded, so an observer costs a
 * function call rather than a second UTF-8 decode of every chunk. Output is
 * only published while a pane is attached to the session, which matches what
 * the `pty-output-{id}` event stream offered: a detached session emits nothing
 * and accrues into its restore snapshot instead.
 */
import { createLogger } from "@src/hooks/logger";

const log = createLogger("PtyOutputBus");

export type PtyOutputObserver = (text: string) => void;

const observersBySession = new Map<string, Set<PtyOutputObserver>>();

/**
 * Observe decoded output for one backend PTY session id. Returns an
 * unsubscribe function.
 */
export function observePtyOutput(
  sessionId: string,
  observer: PtyOutputObserver
): () => void {
  let observers = observersBySession.get(sessionId);
  if (!observers) {
    observers = new Set();
    observersBySession.set(sessionId, observers);
  }
  observers.add(observer);

  return () => {
    const current = observersBySession.get(sessionId);
    if (!current) return;
    current.delete(observer);
    if (current.size === 0) {
      observersBySession.delete(sessionId);
    }
  };
}

/**
 * Publish a decoded chunk. Called from the terminal write path, so it must stay
 * cheap when nobody is observing and must never throw into that path.
 */
export function publishPtyOutput(sessionId: string, text: string): void {
  const observers = observersBySession.get(sessionId);
  if (!observers || observers.size === 0) return;

  // Copy: an observer may unsubscribe itself while being notified, and the
  // ones after it must still receive this chunk.
  for (const observer of [...observers]) {
    try {
      observer(text);
    } catch (error) {
      // An observer is a bystander to terminal rendering; its failure must not
      // stop the chunk reaching the terminal.
      log.warn("[PtyOutputBus] Observer failed:", error);
    }
  }
}

/** Exposed for tests only — do not use in production code. */
export function _resetForTests(): void {
  observersBySession.clear();
}
