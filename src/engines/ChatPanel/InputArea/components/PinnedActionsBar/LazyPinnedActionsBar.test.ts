// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
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

import type { ComposerInputRef } from "@src/components/ComposerInput";

import LazyPinnedActionsBar from "./LazyPinnedActionsBar";

const mocks = vi.hoisted(() => ({
  moduleLoads: 0,
}));

vi.mock(".", async () => {
  mocks.moduleLoads += 1;
  const React = await import("react");
  return {
    default: () =>
      React.createElement("div", {
        "data-testid": "loaded-pinned-actions-bar",
      }),
  };
});

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("LazyPinnedActionsBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.moduleLoads = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps the skills chunk unloaded until visibility is enabled", async () => {
    const composerInputRef = createRef<ComposerInputRef>();

    act(() => {
      root.render(
        createElement(LazyPinnedActionsBar, {
          composerInputRef,
          leadingContent: createElement("span", null, "Plan controls"),
          showPinnedActions: false,
        })
      );
    });

    expect(mocks.moduleLoads).toBe(0);
    expect(container.textContent).toContain("Plan controls");
    expect(
      container.querySelector('[data-testid="loaded-pinned-actions-bar"]')
    ).toBeNull();

    await act(async () => {
      root.render(
        createElement(LazyPinnedActionsBar, {
          composerInputRef,
          leadingContent: createElement("span", null, "Plan controls"),
          showPinnedActions: true,
        })
      );
    });

    expect(mocks.moduleLoads).toBe(1);
    expect(
      container.querySelector('[data-testid="loaded-pinned-actions-bar"]')
    ).not.toBeNull();
  });
});
