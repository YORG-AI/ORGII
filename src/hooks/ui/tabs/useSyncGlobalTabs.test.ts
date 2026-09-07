// @vitest-environment jsdom
import { Provider } from "jotai";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { navigationSidebarTabsAtom } from "@src/store/ui/navigationSidebarTabsAtom";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  useSyncBrowserTabs,
  useSyncTerminalSessions,
} from "./useSyncGlobalTabs";

vi.mock("@src/util/platform/tauri", () => ({ isTauriDesktop: () => false }));

describe("global tab context sync", () => {
  let root: Root;
  let store: ReturnType<typeof createInstrumentedStore>;
  type Props = {
    browsers: Parameters<typeof useSyncBrowserTabs>[0];
    terminals: Parameters<typeof useSyncTerminalSessions>[0];
    activeBrowser: string;
    activeTerminal: string;
  };

  function Harness(props: Props) {
    useSyncBrowserTabs(props.browsers, props.activeBrowser);
    useSyncTerminalSessions(props.terminals, props.activeTerminal);
    return null;
  }

  function render(props: Props) {
    act(() => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, props)
        )
      );
    });
  }

  beforeEach(() => {
    localStorage.clear();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    store = createInstrumentedStore();
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    localStorage.clear();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("syncs additions, selection, metadata and removals while preserving stored non-context tabs", () => {
    const editor = [{ id: "repo", name: "Repo", isActive: true, timestamp: 1 }];
    store.set(navigationSidebarTabsAtom, {
      ...store.get(navigationSidebarTabsAtom),
      editor,
    });
    const initial: Props = {
      browsers: [
        { id: "b1", title: "One", url: "https://example.com", incognito: true },
        { id: "b2", title: "Two" },
      ],
      terminals: [
        { id: "t1", name: "One" },
        { id: "t2", name: "Two" },
      ],
      activeBrowser: "b1",
      activeTerminal: "t1",
    };
    render(initial);
    let state = store.get(navigationSidebarTabsAtom);
    expect(state.browser).toHaveLength(2);
    expect(state.browser.find((tab) => tab.isActive)).toMatchObject({
      id: "b1",
      isPrivate: true,
    });
    expect(state.terminal.find((tab) => tab.isActive)?.id).toBe("t1");

    render({ ...initial, activeBrowser: "b2", activeTerminal: "t2" });
    state = store.get(navigationSidebarTabsAtom);
    expect(state.browser.find((tab) => tab.isActive)?.id).toBe("b2");
    expect(state.terminal.find((tab) => tab.isActive)?.id).toBe("t2");

    const updated: Props = {
      browsers: [{ id: "b2", title: "Updated", url: "https://example.org" }],
      terminals: [{ id: "t2", name: "Two" }],
      activeBrowser: "b2",
      activeTerminal: "t2",
    };
    render(updated);
    state = store.get(navigationSidebarTabsAtom);
    expect(state.browser).toEqual([
      expect.objectContaining({
        id: "b2",
        title: "Updated",
        url: "https://example.org",
        isActive: true,
      }),
    ]);
    expect(state.terminal).toEqual([
      expect.objectContaining({ id: "t2", isActive: true }),
    ]);
    expect(state.editor).toEqual(editor);

    const onChange = vi.fn();
    const unsubscribe = store.sub(navigationSidebarTabsAtom, onChange);
    render({
      ...updated,
      browsers: [...updated.browsers],
      terminals: [...updated.terminals],
    });
    expect(onChange).not.toHaveBeenCalled();
    unsubscribe();

    render({
      browsers: [],
      terminals: [],
      activeBrowser: "",
      activeTerminal: "",
    });
    expect(store.get(navigationSidebarTabsAtom)).toMatchObject({
      browser: [],
      terminal: [],
      editor,
    });
    render(initial);
    expect(store.get(navigationSidebarTabsAtom).browser).toHaveLength(2);
    expect(store.get(navigationSidebarTabsAtom).terminal).toHaveLength(2);
  });
});
