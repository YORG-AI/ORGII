// @vitest-environment jsdom
import { Provider } from "jotai";
import { type ReactNode, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
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

import { ROUTES } from "@src/config/routes";
import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import {
  activeStationChatVisibleAtom,
  chatPanelMaximizedAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import AgentStationTopHeader from "./AgentStationTopHeader";

vi.mock("@src/util/platform/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/util/platform/tauri")>()),
  isMacOS: () => true,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/engines/Simulator/hooks/useCurrentTurnLastAgentMessage", () => ({
  useCurrentTurnLastAgentMessage: () => null,
}));
vi.mock("@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset", () => ({
  getCollapsedSidebarChromeOffset: () => 0,
  useShouldOffsetWorkStationTopBar: () => false,
}));
vi.mock("@src/services/workStation/WorkStationViewService", () => ({
  WorkStationViewService: { showWorkStation: vi.fn(async () => true) },
}));
vi.mock("@src/components/WindowChrome", () => ({
  NoDragRegion: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@src/components/TabPill/TabBarTrailingIconButton", () => ({
  TabBarTrailingIconButton: ({
    children,
    onClick,
    title,
  }: {
    children: ReactNode;
    onClick?: () => void;
    title: string;
  }) => createElement("button", { onClick, title }, children),
}));
vi.mock("../shared", () => ({
  SimulatorAgentChip: () => createElement("span"),
  StationModeChip: () => createElement("span"),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("AgentStationTopHeader", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createInstrumentedStore>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    resetInstrumentedStore();
    store = createInstrumentedStore();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetInstrumentedStore();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderHeader(): void {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(
            MemoryRouter,
            { initialEntries: [ROUTES.workStation.base.path] },
            createElement(AgentStationTopHeader)
          )
        )
      );
    });
  }

  it("renders maximize and close controls when an agent session hides pinned chrome", () => {
    renderHeader();
    act(() => {
      store.set(stationModeAtom, "agent-station");
      store.set(workstationActiveSessionIdAtom, "session-a");
      store.set(activeStationChatVisibleAtom, "agent-station", true);
      store.set(chatWidthAtom, 360);
      store.set(chatPanelMaximizedAtom, false);
    });

    expect(
      container.querySelector('button[title="chat.maximizeWorkStation"]')
    ).not.toBeNull();
    expect(
      container.querySelector('button[title="chat.hideWorkstation"]')
    ).not.toBeNull();
  });

  it("leaves the controls to pinned chrome while Agent Station is empty", () => {
    renderHeader();
    act(() => {
      store.set(stationModeAtom, "agent-station");
      store.set(activeStationChatVisibleAtom, "agent-station", true);
      store.set(chatWidthAtom, 360);
    });

    expect(
      container.querySelector('button[title="chat.maximizeWorkStation"]')
    ).toBeNull();
    expect(
      container.querySelector('button[title="chat.hideWorkstation"]')
    ).toBeNull();
  });
});
