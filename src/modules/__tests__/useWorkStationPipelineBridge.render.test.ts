// @vitest-environment jsdom
import { Provider, useAtomValue } from "jotai";
import { createStore } from "jotai/vanilla";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type ChatPanelTabsState,
  activateChatPanelTabAtom,
  activeChatPanelTabAtom,
  chatPanelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";

import { useWorkStationPipelineBridge } from "../useWorkStationPipelineBridge";

vi.mock("@src/store/session/visitedSessionsAtom", () => ({
  markSessionVisited: vi.fn(),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function AgentStationSessionGate() {
  const activeTab = useAtomValue(activeChatPanelTabAtom);
  useWorkStationPipelineBridge(activeTab?.type === "session");
  const sessionId = useAtomValue(activeSessionIdAtom);
  const workstationSessionId = useAtomValue(workstationActiveSessionIdAtom);

  return React.createElement(
    "div",
    {
      "data-testid": "agent-station-session",
      "data-workstation-session-id": workstationSessionId ?? "",
    },
    sessionId ?? "无活动 Agent 会话"
  );
}

describe("useWorkStationPipelineBridge rendered lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps Agent Station loaded when a late cleanup clears the live pipeline", async () => {
    const store = createStore();
    const tabsState = {
      tabs: [
        { id: "start", type: "start-page", title: "Launchpad" },
        {
          id: "session-tab-A",
          type: "session",
          title: "Session A",
          sessionId: "session-A",
        },
      ],
      activeTabId: "start",
    } satisfies ChatPanelTabsState;

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(AgentStationSessionGate)
        )
      );
    });

    await act(async () => {
      store.set(chatPanelTabsAtom, tabsState);
      // This is the same action invoked by clicking the ChatPanel tab pill;
      // no NavigationSidebar session-row action participates in the test.
      store.set(activateChatPanelTabAtom, "session-tab-A");
    });
    act(() => store.set(activeSessionIdAtom, null));

    expect(store.get(activeSessionIdAtom)).toBe("session-A");
    expect(container.textContent).toBe("session-A");
    expect(container.textContent).not.toContain("无活动 Agent 会话");
  });

  it("allows non-session surfaces to own or release the pipeline", async () => {
    const store = createStore();

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(AgentStationSessionGate)
        )
      );
    });

    act(() => {
      store.set(workstationActiveSessionIdAtom, "session-A");
      store.set(activeSessionIdAtom, "session-A");
      store.set(activeSessionIdAtom, null);
    });

    expect(store.get(activeSessionIdAtom)).toBeNull();
    expect(container.textContent).toBe("无活动 Agent 会话");
  });
});
