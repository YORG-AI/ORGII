// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
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
  browserSessionStateAtom,
  persistBrowserSessionState,
} from "@src/store/workstation/browser/sessionState";
import { createBrowserSessionTab } from "@src/store/workstation/browser/tabs";
import { tabRegistryAtom } from "@src/store/workstation/tabRegistry";
import {
  type WorkStationTab,
  workstationTabsStateAtom,
} from "@src/store/workstation/tabs";
import { emptyWorkstationTabsState } from "@src/store/workstation/tabs/storage";

import WorkstationTabBar from "./WorkstationTabBar";

const tabBarMock = vi.hoisted(() => ({
  props: null as null | {
    tabs: WorkStationTab[];
    onTabClose: (tabId: string) => void;
  },
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  TabBar: (props: typeof tabBarMock.props) => {
    tabBarMock.props = props;
    return null;
  },
  WorkStationTabBarLeading: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./useWorkstationTrailingSlot", () => ({
  useWorkstationTrailingSlot: () => ({ trailingSlot: null }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("WorkstationTabBar browser resource close", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    localStorage.clear();
    tabBarMock.props = null;
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

  it("routes the visible close control through authoritative session teardown", async () => {
    const store = createStore();
    const browserTab = createBrowserSessionTab("browser-1", "Example", {
      url: "https://example.com",
    });
    const state = emptyWorkstationTabsState();
    state.shared.tabs = [browserTab];
    state.globalWorkspace = {
      tabs: [],
      activeTabRef: { partition: "shared", tabId: browserTab.id },
      tabOrder: [{ partition: "shared", tabId: browserTab.id }],
    };
    store.set(workstationTabsStateAtom, state);
    const sessionState = {
      sessions: [
        {
          id: "browser-1",
          title: "Example",
          url: "https://example.com",
          history: ["https://example.com"],
          historyIndex: 0,
          isLoading: false,
          error: null,
          incognito: false,
        },
      ],
      activeSessionId: "browser-1",
    };
    store.set(browserSessionStateAtom, sessionState);
    persistBrowserSessionState(sessionState);
    expect(store.get(tabRegistryAtom).map((entry) => entry.tab.id)).toEqual([
      browserTab.id,
    ]);

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(WorkstationTabBar, { host: "browser" })
        )
      );
    });

    expect(store.get(tabRegistryAtom).map((entry) => entry.tab.id)).toEqual([
      browserTab.id,
    ]);
    expect(tabBarMock.props?.tabs.map((tab) => tab.id)).toEqual([
      browserTab.id,
    ]);

    await act(async () => {
      tabBarMock.props?.onTabClose(browserTab.id);
    });

    expect(store.get(browserSessionStateAtom)).toEqual({
      sessions: [],
      activeSessionId: "",
    });
    expect(store.get(workstationTabsStateAtom).shared.tabs).toEqual([]);
    expect(tabBarMock.props?.tabs).toEqual([]);
  });
});
