/**
 * Global WebGL context slot manager for xterm terminals.
 *
 * macOS enforces a hard per-process limit (~16 WebGL contexts). Each xterm
 * WebglAddon context consumes 10–30 MB of GPU memory. This manager caps
 * simultaneous contexts at a conservative threshold so opening many terminal
 * tabs never exhausts the budget and silently degrades to the slower canvas
 * renderer without a recorded slot release.
 */

const MAX_WEBGL_CONTEXTS = 8;

let activeContextCount = 0;

/**
 * Panes that wanted a context but found the budget full. Without this a
 * terminal that lost the race stays on the DOM renderer for its whole life,
 * even once every other terminal has closed and the budget is empty again.
 */
const slotWaiters = new Set<() => void>();

/**
 * Attempt to reserve a WebGL context slot.
 *
 * Returns `true` when a slot was successfully acquired and the caller should
 * load `WebglAddon`. Returns `false` when the budget is exhausted — the
 * caller must fall back to the canvas renderer and must NOT call
 * `releaseWebglSlot`.
 */
export function acquireWebglSlot(): boolean {
  if (activeContextCount >= MAX_WEBGL_CONTEXTS) {
    return false;
  }
  activeContextCount += 1;
  return true;
}

/**
 * Release a previously acquired WebGL context slot.
 *
 * Must be called exactly once per successful `acquireWebglSlot()` call, when
 * the associated `WebglAddon` is disposed (on context loss or terminal
 * teardown).
 */
export function releaseWebglSlot(): void {
  if (activeContextCount > 0) {
    activeContextCount -= 1;
  }
  // Copy first: a waiter that acquires the freed slot unsubscribes from inside
  // this loop, and the ones after it must still be told a slot was released so
  // they keep waiting for the next one rather than being skipped silently.
  for (const waiter of [...slotWaiters]) {
    waiter();
  }
}

/**
 * Register interest in the next freed context slot.
 *
 * The listener fires after every release while the budget has room; it should
 * attempt `acquireWebglSlot()` and unsubscribe once it succeeds. Returns the
 * unsubscribe function.
 */
export function onWebglSlotReleased(listener: () => void): () => void {
  slotWaiters.add(listener);
  return () => {
    slotWaiters.delete(listener);
  };
}

/** Exposed for tests only — do not use in production code. */
export function _getActiveContextCount(): number {
  return activeContextCount;
}

/** Exposed for tests only — do not use in production code. */
export function _resetForTests(): void {
  activeContextCount = 0;
  slotWaiters.clear();
}
