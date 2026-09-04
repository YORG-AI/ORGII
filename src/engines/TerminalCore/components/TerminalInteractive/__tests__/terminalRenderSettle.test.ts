import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelRenderSettle,
  writeWithRenderSettle,
} from "../terminalRenderSettle";

const SYNCHRONIZED_END = "\x1b[?2026l";

interface FakeTerminal {
  rows: number;
  buffer: { active: { baseY: number; viewportY: number } };
  refresh: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  /** Run the parse callback the most recent write handed to xterm. */
  finishWrite: () => void;
}

function createFakeTerminal(): FakeTerminal {
  let pendingCallback: (() => void) | undefined;

  const terminal: FakeTerminal = {
    rows: 24,
    buffer: { active: { baseY: 0, viewportY: 0 } },
    refresh: vi.fn(),
    // xterm buffers writes and parses them later, so the callback is stored
    // rather than invoked — the settle logic only runs once it fires.
    write: vi.fn((_data: unknown, callback?: () => void) => {
      pendingCallback = callback;
    }),
    finishWrite: () => {
      const callback = pendingCallback;
      pendingCallback = undefined;
      callback?.();
    },
  };
  return terminal;
}

function asTerminal(fake: FakeTerminal): Terminal {
  return fake as unknown as Terminal;
}

let frameCallbacks: FrameRequestCallback[];

beforeEach(() => {
  frameCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frameCallbacks[id - 1] = () => {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function runFrames(): void {
  const pending = frameCallbacks;
  frameCallbacks = [];
  for (const callback of pending) callback(0);
}

describe("writeWithRenderSettle", () => {
  it("passes the data straight through to the terminal", () => {
    const terminal = createFakeTerminal();

    writeWithRenderSettle(asTerminal(terminal), "hello");

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write.mock.calls[0]?.[0]).toBe("hello");
  });

  it("does not repaint when the write left the viewport where it was", () => {
    const terminal = createFakeTerminal();

    writeWithRenderSettle(asTerminal(terminal), "still here");
    terminal.finishWrite();

    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(frameCallbacks).toHaveLength(0);
  });

  it("repaints the viewport when the write scrolled it", () => {
    const terminal = createFakeTerminal();

    writeWithRenderSettle(asTerminal(terminal), "line\r\n");
    terminal.buffer.active.baseY = 1;
    terminal.finishWrite();

    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("repaints once more on the next frame after a scroll", () => {
    const terminal = createFakeTerminal();

    writeWithRenderSettle(asTerminal(terminal), "line\r\n");
    terminal.buffer.active.viewportY = 1;
    terminal.finishWrite();
    expect(terminal.refresh).toHaveBeenCalledTimes(1);

    runFrames();

    expect(terminal.refresh).toHaveBeenCalledTimes(2);
  });

  it("collapses follow-up repaints from a burst into a single frame", () => {
    const terminal = createFakeTerminal();

    for (let line = 1; line <= 3; line++) {
      writeWithRenderSettle(asTerminal(terminal), "line\r\n");
      terminal.buffer.active.baseY = line;
      terminal.finishWrite();
    }
    expect(terminal.refresh).toHaveBeenCalledTimes(3);

    runFrames();

    // Three scrolls, three immediate repaints, but one settle frame — not three.
    expect(terminal.refresh).toHaveBeenCalledTimes(4);
  });

  it("repaints a synchronized-update frame even without a scroll", () => {
    const terminal = createFakeTerminal();

    writeWithRenderSettle(
      asTerminal(terminal),
      `\x1b[?2026hredraw${SYNCHRONIZED_END}`
    );
    terminal.finishWrite();

    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
    // Nothing scrolled, so no follow-up frame is needed.
    expect(frameCallbacks).toHaveLength(0);
  });

  it("skips the synchronized-frame check for byte payloads", () => {
    const terminal = createFakeTerminal();

    writeWithRenderSettle(asTerminal(terminal), new Uint8Array([0x61]));
    terminal.finishWrite();

    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("swallows a repaint failure so the write buffer keeps draining", () => {
    const terminal = createFakeTerminal();
    terminal.refresh.mockImplementation(() => {
      throw new Error("renderer disposed");
    });

    writeWithRenderSettle(asTerminal(terminal), "line\r\n");
    terminal.buffer.active.baseY = 1;

    expect(() => terminal.finishWrite()).not.toThrow();
  });

  it("drops a queued follow-up repaint when the pane is torn down", () => {
    const terminal = createFakeTerminal();

    writeWithRenderSettle(asTerminal(terminal), "line\r\n");
    terminal.buffer.active.baseY = 1;
    terminal.finishWrite();
    terminal.refresh.mockClear();

    cancelRenderSettle(asTerminal(terminal));
    runFrames();

    expect(terminal.refresh).not.toHaveBeenCalled();
  });
});
