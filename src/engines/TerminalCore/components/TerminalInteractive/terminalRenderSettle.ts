/**
 * Repaint coordination for foreground terminal writes.
 *
 * xterm marks the rows a chunk touched dirty and lets its render debouncer
 * paint them on the next frame. That is correct for output that only appends,
 * but two cases leave the screen a frame behind what the buffer already holds:
 *
 * - A write that scrolls the viewport. The compositor can present the frame
 *   before the freshly scrolled-in row has been rasterized, so the top of the
 *   screen shows stale content until something else causes a repaint — which
 *   is why the row appears to "fix itself" when the window is nudged.
 * - A synchronized-update frame (DEC mode 2026). A TUI wraps a full-screen
 *   redraw in `?2026h`/`?2026l` precisely so nothing paints mid-update, so the
 *   whole frame lands on the closing sequence and must repaint as a unit.
 *
 * Both are handled by refreshing the visible rows once the chunk has actually
 * parsed, plus one follow-up frame after a scroll so a late-rasterized row
 * still gets presented. `refresh()` only marks rows dirty — the debouncer
 * still coalesces to one paint per frame, so a burst of chunks costs one
 * repaint, not one per chunk.
 */
import type { Terminal } from "@xterm/xterm";

/** Closing sequence of a DEC 2026 synchronized update. */
const SYNCHRONIZED_OUTPUT_END = "\x1b[?2026l";

const pendingSettleFrames = new WeakMap<Terminal, number>();

interface ViewportPosition {
  baseY: number;
  viewportY: number;
}

function readViewportPosition(terminal: Terminal): ViewportPosition {
  const active = terminal.buffer?.active;
  return {
    baseY: active?.baseY ?? -1,
    viewportY: active?.viewportY ?? -1,
  };
}

function refreshVisibleRows(terminal: Terminal): void {
  try {
    if (terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
  } catch {
    // The terminal can be disposed between a write and its parse callback;
    // PTY output routinely races pane teardown.
  }
}

function scheduleFollowupRefresh(terminal: Terminal): void {
  const pending = pendingSettleFrames.get(terminal);
  if (pending !== undefined) {
    cancelAnimationFrame(pending);
  }
  const frameId = requestAnimationFrame(() => {
    pendingSettleFrames.delete(terminal);
    refreshVisibleRows(terminal);
  });
  pendingSettleFrames.set(terminal, frameId);
}

/** Drop a queued follow-up repaint. Call before disposing the terminal. */
export function cancelRenderSettle(terminal: Terminal): void {
  const pending = pendingSettleFrames.get(terminal);
  if (pending === undefined) return;
  cancelAnimationFrame(pending);
  pendingSettleFrames.delete(terminal);
}

/**
 * Write a chunk to a visible terminal and repaint once it has parsed, when the
 * write either scrolled the viewport or completed a synchronized-update frame.
 *
 * Returns whatever `terminal.write` would — callers keep their own guards.
 */
export function writeWithRenderSettle(
  terminal: Terminal,
  data: string | Uint8Array
): void {
  const before = readViewportPosition(terminal);
  const completesSynchronizedFrame =
    typeof data === "string" && data.includes(SYNCHRONIZED_OUTPUT_END);

  terminal.write(data, () => {
    // This callback runs inside xterm's write-buffer loop, where an escaping
    // throw stops the buffer draining and silences the terminal for good.
    try {
      const after = readViewportPosition(terminal);
      const scrolled =
        after.baseY !== before.baseY || after.viewportY !== before.viewportY;
      if (!scrolled && !completesSynchronizedFrame) return;

      refreshVisibleRows(terminal);
      if (scrolled) {
        scheduleFollowupRefresh(terminal);
      }
    } catch {
      // Never let repaint bookkeeping wedge the write buffer.
    }
  });
}
