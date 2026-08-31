// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settingsAtom } from "@src/store/settings/settingsAtom";

import { TerminalCore } from "..";
import type { UseTerminalStateReturn } from "../types";

const runtime = vi.hoisted(() => ({ create: vi.fn(), fit: vi.fn() }));
vi.mock("@src/hooks/terminal", () => ({ useTerminalProcessPoller: () => {} }));
vi.mock("@/src/scaffold/ContextMenu/exports", () => ({
  TextSelectionDropdown: () => null,
}));
vi.mock("../components/TerminalSearchPanel", () => ({
  TerminalSearchPanel: () => null,
}));
// Keep TerminalCore, TerminalView, and appearance effects real; replace only
// xterm/native setup so the test never launches a PTY or creates a GPU context.
vi.mock("../components/TerminalInteractive/terminalSetup", () => ({
  createTerminalInstance: (options: unknown) => runtime.create(options),
  initializeWhenContainerVisible: ({
    setIsReady,
  }: {
    setIsReady: (ready: boolean) => void;
  }) => {
    setIsReady(true);
    return () => {};
  },
  loadTerminalWebgl: vi.fn(),
}));
vi.mock("../components/TerminalInteractive/terminalHandlers", () => ({
  registerTerminalEventHandlers: () => () => {},
}));
vi.mock("../components/TerminalInteractive/terminalLifecycle", () => ({
  cleanupPtyListeners: vi.fn(),
}));
vi.mock("../components/TerminalInteractive/terminalPty", () => ({
  initPtyConnection: vi.fn(),
}));
vi.mock("../components/TerminalInteractive/terminalOutputScheduler", () => ({
  setPaneForeground: vi.fn(),
  flushBacklog: vi.fn(),
}));
vi.mock("../components/TerminalInteractive/terminalSizing", () => ({
  createFitTerminal: () => runtime.fit,
  createRedrawTerminalAfterLayoutChange: () => () => {},
}));
vi.mock("../components/TerminalInteractive/useTerminalResizeListeners", () => ({
  useTerminalResizeListeners: () => {},
}));

function terminalState(id: string): UseTerminalStateReturn {
  const session = { id, name: id, isActive: true };
  return {
    sessions: [session],
    activeSessionId: id,
    activeSession: session,
    initializedSessions: new Set([id]),
    addSession: () => "",
    closeSession: () => {},
    setActiveSession: () => {},
    markSessionInitialized: () => {},
    updateSessionInfo: () => {},
    renameSession: () => {},
  };
}

describe("terminal host font sizes", () => {
  let root: Root;
  let container: HTMLDivElement;
  let store: ReturnType<typeof createStore>;
  const pinnedState = terminalState("pinned");
  const stationState = terminalState("station");

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 16)
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    store = createStore();
    store.set(settingsAtom, {
      ...store.get(settingsAtom),
      "terminal.fontSize": 18,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    runtime.create.mockReset();
    runtime.fit.mockReset();
    runtime.create.mockImplementation(
      ({ terminalFontSize }: { terminalFontSize: number }) => ({
        terminal: {
          options: { fontSize: terminalFontSize },
          rows: 24,
          open: vi.fn(),
          dispose: vi.fn(),
          clearTextureAtlas: vi.fn(),
          refresh: vi.fn(),
        },
        fitAddon: {},
        searchAddon: {},
        serializeAddon: {},
      })
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  function render(fontSize?: number) {
    act(() =>
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(TerminalCore, {
            terminalState: pinnedState,
            fontSize,
          }),
          React.createElement(TerminalCore, { terminalState: stationState })
        )
      )
    );
  }

  it("scopes initial and live font overrides without recreating either terminal", () => {
    render(12);
    expect(runtime.create).toHaveBeenCalledTimes(2);
    expect(
      runtime.create.mock.calls.map(([options]) => options.terminalFontSize)
    ).toEqual([12, 18]);
    const [pinned, station] = runtime.create.mock.results.map(
      ({ value }) => value.terminal
    );
    act(() => vi.runAllTimers());

    act(() =>
      store.set(settingsAtom, {
        ...store.get(settingsAtom),
        "terminal.fontSize": 20,
      })
    );
    expect(pinned.options.fontSize).toBe(12);
    expect(station.options.fontSize).toBe(20);
    act(() => vi.runAllTimers());

    runtime.fit.mockClear();
    render(11);
    expect(pinned.options.fontSize).toBe(11);
    expect(station.options.fontSize).toBe(20);
    act(() => vi.advanceTimersByTime(50));
    expect(runtime.fit).toHaveBeenCalledTimes(1);

    render();
    expect(pinned.options.fontSize).toBe(20);
    expect(store.get(settingsAtom)["terminal.fontSize"]).toBe(20);
    expect(runtime.create).toHaveBeenCalledTimes(2);
    expect(pinned.dispose).not.toHaveBeenCalled();
    expect(station.dispose).not.toHaveBeenCalled();
    // Leave the final fit pending: unmount must cancel it in afterEach.
  });
});
