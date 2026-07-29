// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
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

import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";

import { WorkStationStartPage } from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "spotlightActions.openAgentStation" ? "Go to Agent Station" : key,
  }),
}));

vi.mock("@src/hooks/git/useActiveRepoRef", () => ({
  useActiveRepoRef: () => ({ repoId: null, repoPath: "" }),
}));

vi.mock("@src/hooks/git/useWorkingTreeDiffTotals", () => ({
  useWorkingTreeDiffTotals: () => ({ additions: 0, deletions: 0 }),
}));

vi.mock("../useWorkStationLaunchActions", () => ({
  LAUNCHPAD_ACTION_IDS: [],
  useWorkStationLaunchActions: () => [],
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("WorkStationStartPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    localStorage.clear();
    store = createStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("shows the Agent Station action and divider for a selected session", async () => {
    await act(async () => {
      root.render(
        createElement(Provider, { store }, createElement(WorkStationStartPage))
      );
    });
    await act(async () => {
      store.set(workstationActiveSessionIdAtom, "session-1");
    });

    const action = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Go to Agent Station")
    );

    expect(action).toBeDefined();
    expect(action?.textContent).toContain("2");
    expect(container.querySelector('[role="separator"]')).not.toBeNull();

    await act(async () => action?.click());
    expect(store.get(stationModeAtom)).toBe("agent-station");
  });

  it("hides the Agent Station action when no session is selected", async () => {
    await act(async () => {
      root.render(
        createElement(Provider, { store }, createElement(WorkStationStartPage))
      );
    });

    expect(container.textContent).not.toContain("Go to Agent Station");
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });
});
