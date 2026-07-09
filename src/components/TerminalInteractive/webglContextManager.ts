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
}

/** Exposed for tests only — do not use in production code. */
export function _getActiveContextCount(): number {
  return activeContextCount;
}

/** Exposed for tests only — do not use in production code. */
export function _resetForTests(): void {
  activeContextCount = 0;
}
