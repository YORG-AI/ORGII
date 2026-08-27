import { describe, expect, it, vi } from "vitest";

import {
  createFitTerminal,
  createRedrawTerminalAfterLayoutChange,
} from "../terminalSizing";

function visibleContainer() {
  return {
    getBoundingClientRect: () => ({ height: 240, width: 320 }),
  } as HTMLDivElement;
}

describe("terminal sizing lifecycle", () => {
  it("does not redraw a disposed terminal after a replacement mounts", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    const oldTerminal = {
      clearTextureAtlas: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    };
    const newTerminal = {
      clearTextureAtlas: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    };
    const oldFitAddon = { fit: vi.fn() };
    const newFitAddon = { fit: vi.fn() };
    const container = visibleContainer();
    const refs = {
      containerRef: { current: container },
      fitAddonRef: { current: oldFitAddon },
      terminalRef: { current: oldTerminal },
    };

    const redraw = createRedrawTerminalAfterLayoutChange(refs as never);
    redraw();

    refs.terminalRef.current = newTerminal;
    refs.fitAddonRef.current = newFitAddon;
    frames[0]?.(0);

    expect(oldTerminal.clearTextureAtlas).not.toHaveBeenCalled();
    expect(oldTerminal.refresh).not.toHaveBeenCalled();
    expect(oldFitAddon.fit).not.toHaveBeenCalled();
    expect(newFitAddon.fit).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fits layout changes without clearing the renderer or forcing a full refresh", () => {
    const terminal = {
      clearTextureAtlas: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    };
    const fitAddon = { fit: vi.fn() };
    const refs = {
      containerRef: { current: visibleContainer() },
      fitAddonRef: { current: fitAddon },
      terminalRef: { current: terminal },
    };

    createFitTerminal(refs as never)();

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(terminal.clearTextureAtlas).not.toHaveBeenCalled();
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("redraws only when terminal, addon, and container identities remain live", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    const terminal = {
      clearTextureAtlas: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    };
    const fitAddon = { fit: vi.fn() };
    const refs = {
      containerRef: { current: visibleContainer() },
      fitAddonRef: { current: fitAddon },
      terminalRef: { current: terminal },
    };

    createRedrawTerminalAfterLayoutChange(refs as never)();
    frames[0]?.(0);

    expect(terminal.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
    vi.unstubAllGlobals();
  });
});
