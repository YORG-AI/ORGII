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

  it("keeps the narrow four-action card grid compact", () => {
    act(() => {
      root.render(
        createElement(
          LaunchpadActionGrid,
          { layoutActionCount: 4, presentation: "card" },
          createElement(LaunchpadActionCard, {
            action,
            presentation: "card",
          })
        )
      );
    });

    const grid = container.querySelector<HTMLElement>(
      ".launchpad-action-grid-content"
    );
    expect(grid?.parentElement?.className).toContain("max-w-[320px]");
  });

  it("pins compositor layers so hover repaints cannot re-round icon pixels", () => {
    act(() => {
      root.render(
        createElement(
          LaunchpadActionGrid,
          {
            collapsible: true,
            controlAlignment: "center",
            presentation: "card",
          },
          createElement(LaunchpadActionCard, {
            action,
            presentation: "card",
          })
        )
      );
    });

    // The launchpad block is positioned on a fractional device pixel, so a
    // compositor layer that is created and destroyed on hover re-rounds every
    // icon inside it. Both layers must stay pinned.
    const collapseZone = container.querySelector<HTMLElement>(
      '[data-testid="launchpad-action-grid-collapse-zone"]'
    );
    expect(collapseZone?.className).toContain("transition-opacity");
    expect(collapseZone?.className).toContain("will-change-[opacity]");

    const card = container.querySelector<HTMLElement>(
      '[data-testid="chat-panel-start-page-test-action"]'
    );
    expect(card?.className).toContain("transition-colors");
    expect(card?.className).toContain("transform-gpu");
  });

  it("keeps the pill presentation on its own compositor layer", () => {
    act(() => {
      root.render(
        createElement(LaunchpadActionCard, { action, presentation: "pill" })
      );
    });

    const pill = container.querySelector<HTMLElement>(
      '[data-testid="chat-panel-start-page-test-action"]'
    );
    expect(pill?.className).toContain("transform-gpu");
  });

  it("reuses the icon disclosure control for the compact card state", () => {
    act(() => {
      root.render(
        createElement(
          LaunchpadActionGrid,
          {
            collapseLabel: "Hide suggestions",
            collapsible: true,
            expandLabel: "Show suggestions",
            header: createElement("span", null, "ADE Manager"),
            presentation: "card",
          },
          createElement(LaunchpadActionCard, {
            action,
            presentation: "card",
          })
        )
      );
    });

    const grid = container.querySelector<HTMLElement>(
      ".launchpad-action-grid-compact"
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="launchpad-action-grid-compact-toggle"]'
    );
    const header = container.querySelector<HTMLElement>(
      ".launchpad-action-grid-header"
    );

    expect(grid?.dataset.compactExpanded).toBe("false");
    expect(grid?.className).not.toContain("hidden @[640px]/focusedchat:block");
    expect(header?.textContent).toContain("ADE Manager");
    expect(header?.className).toContain("flex-col");
    expect(header?.className).toContain("items-center");
    expect(header?.className).toContain("w-fit");
    // The disclosure belongs with the cards it toggles, not with the title,
    // and shares the standard control's wrapper so both land in the same spot.
    expect(header?.querySelector("button")).toBeNull();
    const content = container.querySelector<HTMLElement>(
      ".launchpad-action-grid-content"
    )!;
    const toggleZone = toggle!.closest(
      ".launchpad-action-grid-compact-toggle"
    )!;
    expect(content).not.toBeNull();
    expect(toggleZone).not.toBeNull();
    expect(
      content.compareDocumentPosition(toggleZone) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(toggleZone.className).toContain("w-full");
    // Same alignment vocabulary as the standard expand zone (`controlAlignment`
    // defaults to "left" here), so the two controls dock identically.
    expect(toggleZone.className).toContain("justify-start");
    expect(toggleZone.className).toContain("pl-2.5");
    expect(toggle?.getAttribute("aria-label")).toBe("Show suggestions");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.querySelector('[data-icon="ellipsis"]')).not.toBeNull();
    expect(container.textContent).toContain("Test action");

    act(() => toggle?.click());

    expect(grid?.dataset.compactExpanded).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("Hide suggestions");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.querySelector('[data-icon="chevron-up"]')).not.toBeNull();
  });
});
