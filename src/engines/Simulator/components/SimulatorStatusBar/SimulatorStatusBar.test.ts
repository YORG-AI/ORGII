// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { replayModeAtom } from "@src/engines/SessionCore";

import { SimulatorStatusBar } from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "simulator.replay.freeBrowse" ? "Free browse" : key,
  }),
}));

vi.mock("./EventFilterDropdown", () => ({
  EventFilterDropdown: () => null,
}));
vi.mock("./FollowModeDropdown", () => ({ FollowModeDropdown: () => null }));
vi.mock("./PlaybackSpeedInline", () => ({ PlaybackSpeedInline: () => null }));
vi.mock("./ReplayTimestampSegment", () => ({
  ReplayTimestampSegment: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SimulatorStatusBar follow mode", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("shows a labeled free-browse icon and exits follow mode when selected", () => {
    const store = createStore();
    store.set(replayModeAtom, "follow");

    act(() => {
      root.render(
        createElement(Provider, { store }, createElement(SimulatorStatusBar))
      );
    });

    const freeBrowse = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-replay-free-browse"]'
    );
    expect(freeBrowse?.getAttribute("aria-label")).toBe("Free browse");
    expect(freeBrowse?.textContent).toBe("");

    act(() => freeBrowse?.click());
    expect(store.get(replayModeAtom)).toBe("replay");
  });
});
