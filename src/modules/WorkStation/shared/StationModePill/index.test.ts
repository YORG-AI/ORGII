// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { type ReactNode, act, createElement } from "react";
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

import { stationModeAtom } from "@src/store/ui/simulatorAtom";

import StationModePill from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "terminology.myStation") return "My Station";
      if (key === "terminology.agentStation") return "Agent Station";
      return key;
    },
  }),
}));

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("StationModePill", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    store = createStore();
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

  function renderPill() {
    act(() => {
      root.render(
        createElement(Provider, { store }, createElement(StationModePill))
      );
    });
  }

  it("exposes the selected station as an accessible pressed button", () => {
    store.set(stationModeAtom, "my-station");
    renderPill();

    const myStation = container.querySelector<HTMLButtonElement>(
      '[data-testid="station-mode-my-station"]'
    );
    const agentStation = container.querySelector<HTMLButtonElement>(
      '[data-testid="station-mode-agent-station"]'
    );

    expect(myStation?.getAttribute("aria-label")).toBe("My Station");
    expect(myStation?.getAttribute("aria-pressed")).toBe("true");
    expect(agentStation?.getAttribute("aria-label")).toBe("Agent Station");
    expect(agentStation?.getAttribute("aria-pressed")).toBe("false");
    expect(myStation?.classList.contains("bg-primary-6")).toBe(true);
    expect(myStation?.classList.contains("text-white")).toBe(true);
    expect(agentStation?.classList.contains("bg-transparent")).toBe(true);
    expect(agentStation?.classList.contains("text-text-1")).toBe(true);
    expect(myStation?.style.height).toBe("24px");
    expect(myStation?.style.width).toBe("28px");
  });

  it("updates the atom and pressed state through the canonical button", () => {
    store.set(stationModeAtom, "my-station");
    renderPill();

    const agentStation = container.querySelector<HTMLButtonElement>(
      '[data-testid="station-mode-agent-station"]'
    );

    act(() => agentStation?.click());

    expect(store.get(stationModeAtom)).toBe("agent-station");
    expect(agentStation?.getAttribute("aria-pressed")).toBe("true");
    expect(agentStation?.classList.contains("bg-primary-6")).toBe(true);
  });
});
