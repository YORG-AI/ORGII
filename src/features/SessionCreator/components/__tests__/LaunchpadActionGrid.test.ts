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

import {
  type LaunchpadAction,
  LaunchpadActionCard,
  LaunchpadActionGrid,
} from "../LaunchpadActionGrid";

describe("LaunchpadActionGrid", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const action: LaunchpadAction = {
    id: "test-action",
    title: "Test action",
    icon: createElement("span", null, "icon"),
    onClick: vi.fn(),
    tone: "neutral",
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("collapses and restores a card grid with tertiary controls", () => {
    act(() => {
      root.render(
        createElement(
          LaunchpadActionGrid,
          {
            collapsible: true,
            collapseLabel: "Hide suggestions",
            controlAlignment: "center",
            expandLabel: "Show suggestions",
            presentation: "card",
          },
          createElement(LaunchpadActionCard, {
            action,
            presentation: "card",
          })
        )
      );
    });

    const collapseButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="launchpad-action-grid-collapse"]'
    );
    expect(collapseButton).not.toBeNull();
    expect(collapseButton?.getAttribute("aria-label")).toBe("Hide suggestions");
    expect(collapseButton?.className).toContain("text-text-2");
    const collapseZone = container.querySelector<HTMLElement>(
      '[data-testid="launchpad-action-grid-collapse-zone"]'
    );
    expect(collapseZone?.className).toContain("top-full");
    expect(collapseZone?.className).toContain("left-1/2");
    expect(collapseZone?.className).toContain("-translate-x-1/2");
    expect(collapseZone?.className).toContain("pt-1");
    expect(collapseZone?.className).not.toContain("pointer-events-none");
    expect(container.textContent).toContain("Test action");

    act(() => collapseButton?.click());

    const expandButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="launchpad-action-grid-expand"]'
    );
    expect(
      container
        .querySelector('[data-testid="chat-panel-start-page-test-action"]')
        ?.closest("[hidden]")
    ).not.toBeNull();
    expect(container.querySelector("[hidden]")?.className).toContain("hidden");
    expect(expandButton).not.toBeNull();
    expect(expandButton?.getAttribute("aria-label")).toBe("Show suggestions");
    expect(expandButton?.className).toContain("text-text-2");
    const expandZone = container.querySelector<HTMLElement>(
      '[data-testid="launchpad-action-grid-expand-zone"]'
    );
    expect(expandZone?.className).toContain("w-full");
    expect(expandZone?.className).toContain("justify-center");
    expect(
      expandButton?.querySelector('[data-icon="ellipsis"]')
    ).not.toBeNull();

    act(() => expandButton?.click());

    expect(container.textContent).toContain("Test action");
    expect(
      container.querySelector('[data-testid="launchpad-action-grid-collapse"]')
    ).not.toBeNull();
  });
});
