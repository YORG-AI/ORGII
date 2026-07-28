// @vitest-environment jsdom
import { act, createElement } from "react";
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

import FactoryViewPill, { parseFactoryViewMode } from ".";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openRuntime: vi.fn(),
  search: "?view=list",
}));

vi.mock("jotai", () => ({
  useSetAtom: () => mocks.openRuntime,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ search: mocks.search }),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@src/store/chatPanel/chatPanelTabsAtom", () => ({
  openRuntimeInChatPanelTabAtom: Symbol("openRuntimeInChatPanelTabAtom"),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("FactoryViewPill", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        disconnect() {}
      }
    );
  });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.search = "?view=list";
    await act(async () => {
      root.render(createElement(FactoryViewPill));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    vi.unstubAllGlobals();
  });

  it("opens Data Sources in the singleton Runtime tab", async () => {
    const dataSourceButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="kanban-view-data-source-runtime"]'
    );

    expect(dataSourceButton?.dataset.active).toBe("false");
    await act(async () => dataSourceButton?.click());

    expect(mocks.openRuntime).toHaveBeenCalledWith(
      "chat.startPage.tabs.runtime"
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("reveals the trailing arrow-up-right icon on hover", async () => {
    const dataSourceButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="kanban-view-data-source-runtime"]'
    );
    const icon = container.querySelector(
      '[data-testid="kanban-data-source-runtime-icon"]'
    );

    expect(icon?.classList.contains("lucide-arrow-up-right")).toBe(true);
    expect(icon?.parentElement?.classList.contains("invisible")).toBe(true);

    await act(async () => {
      dataSourceButton?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
    });

    expect(icon?.parentElement?.classList.contains("invisible")).toBe(false);
  });

  it("treats stale Data Source URLs as Kanban instead of mounting duplicate content", () => {
    expect(parseFactoryViewMode("?view=datasource")).toBe("kanban");
  });
});
