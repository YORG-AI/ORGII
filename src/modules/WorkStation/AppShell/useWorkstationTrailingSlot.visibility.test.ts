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
import { workstationProjectTabBarAtom } from "@src/store/workstation";
import {
  type WorkstationTabHost,
  tabTypeToTabHost,
} from "@src/store/workstation/tabHost";
import type { WorkStationTabType } from "@src/store/workstation/tabs/types";
import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import { useWorkstationTrailingSlot } from "./useWorkstationTrailingSlot";

const { pinnedChromeVisibleMock } = vi.hoisted(() => ({
  pinnedChromeVisibleMock: vi.fn(),
}));

vi.mock("@src/hooks/ui/workbench/usePinnedWorkbenchChrome", () => ({
  usePinnedWorkbenchChromeVisible: pinnedChromeVisibleMock,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/services/workStation/WorkStationViewService", () => ({
  WorkStationViewService: { showWorkStation: vi.fn(async () => true) },
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
vi.mock("@src/modules/WorkStation/AppShell/TabBarPlusMenu", () => ({
  TabBarPlusMenu: () => createElement("button", { title: "new-tab" }),
}));
vi.mock(
  "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectManagerWorkItemsTabBarTrailing",
  () => ({ default: () => createElement("span", { title: "project-actions" }) })
);

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function TrailingSlotHarness({ host }: { host: WorkstationTabHost }) {
  const { trailingSlot } = useWorkstationTrailingSlot({ host, visible: [] });
  return createElement("div", null, trailingSlot);
}

describe("useWorkstationTrailingSlot pane controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createInstrumentedStore>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    pinnedChromeVisibleMock.mockReturnValue(false);
    resetInstrumentedStore();
    localStorage.clear();
    store = createInstrumentedStore();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetInstrumentedStore();
    pinnedChromeVisibleMock.mockReset();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderHost(host: WorkstationTabHost): void {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(
            MemoryRouter,
            { initialEntries: [ROUTES.workStation.base.path] },
            createElement(TrailingSlotHarness, { host })
          )
        )
      );
    });
  }

  function expectPaneControls(): void {
    expect(
      container.querySelector(
        'button[title="sessions:chat.maximizeWorkStation"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector('button[title="sessions:chat.hideWorkstation"]')
    ).not.toBeNull();
  }

  it.each<WorkStationTabType>([
    "file",
    "browser-session",
    "project-dashboard",
    "project-work-items",
    "workItem-detail",
  ])("keeps maximize and close available for populated %s tabs", (tabType) => {
    renderHost(tabTypeToTabHost(tabType));

    expectPaneControls();
  });

  it("leaves empty My Station controls to the pinned window chrome", () => {
    pinnedChromeVisibleMock.mockReturnValue(true);
    renderHost("code");

    expect(
      container.querySelector(
        'button[title="sessions:chat.maximizeWorkStation"]'
      )
    ).toBeNull();
    expect(
      container.querySelector('button[title="sessions:chat.hideWorkstation"]')
    ).toBeNull();
  });

  it("preserves project-specific trailing actions beside shared pane controls", () => {
    store.set(workstationProjectTabBarAtom, { onAddProject: vi.fn() });
    renderHost("project");

    expect(container.querySelector('[title="project-actions"]')).not.toBeNull();
    expectPaneControls();
  });
});
