import { Provider } from "jotai";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { type UseSessionViewReturn, useSessionView } from "./useSessionView";

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => () => undefined,
}));

describe("useSessionView", () => {
  it("preserves maximized chat when switching sessions", () => {
    const store = createInstrumentedStore();
    store.set(chatPanelMaximizedAtom, true);

    let sessionView: UseSessionViewReturn | undefined;
    function HookProbe(): null {
      // Test probe: capture the hook API synchronously from server rendering.
      // eslint-disable-next-line react-hooks/globals -- server-rendered test probe synchronously exports the hook result; the component never mounts or re-renders
      sessionView = useSessionView();
      return null;
    }

    renderToString(
      React.createElement(Provider, { store }, React.createElement(HookProbe))
    );

    sessionView?.openSession("session-b", "Session B", "/repo");

    expect(store.get(chatPanelMaximizedAtom)).toBe(true);
    expect(store.get(workstationActiveSessionIdAtom)).toBe("session-b");
    expect(store.get(activeSessionIdAtom)).toBe("session-b");
    const tabs = store.get(chatPanelTabsAtom);
    expect(tabs.tabs.find((tab) => tab.id === tabs.activeTabId)).toMatchObject({
      type: "session",
      sessionId: "session-b",
    });
  });
});
