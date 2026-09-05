// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReplayTurnBreakpoints from "./ReplayTurnBreakpoints";
import type { ReplayProgressSegment } from "./types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const segments: ReplayProgressSegment[] = [
  {
    id: "round-1",
    turnNumber: 1,
    leftPercent: 0,
    tooltip: "Turn 1 · 2m",
    ariaLabel: "Replay turn 1",
  },
  {
    id: "round-2",
    turnNumber: 2,
    leftPercent: 30,
    tooltip: "Turn 2 · 3m · 12:27–12:30",
    ariaLabel: "Replay turn 2",
    isActive: true,
  },
  {
    id: "round-3",
    turnNumber: 3,
    leftPercent: 75,
    tooltip: "Turn 3 · 1m · 12:30–12:31",
    ariaLabel: "Replay turn 3",
  },
];

describe("ReplayTurnBreakpoints", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders only internal round boundaries at their scrubber positions", () => {
    act(() => {
      root.render(createElement(ReplayTurnBreakpoints, { segments }));
    });

    const markers = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="replay-turn-breakpoint"]'
    );
    expect(markers).toHaveLength(2);
    expect(markers[0]?.style.left).toBe("30%");
    expect(markers[0]?.getAttribute("aria-label")).toBe("Replay turn 2");
    expect(markers[0]?.getAttribute("aria-current")).toBe("step");
    expect(markers[1]?.style.left).toBe("75%");
  });

  it("shows round details on hover and seeks from the marker", () => {
    const onSegmentClick = vi.fn();
    act(() => {
      root.render(
        createElement(ReplayTurnBreakpoints, {
          segments,
          onSegmentClick,
        })
      );
    });

    const marker = container.querySelector<HTMLButtonElement>(
      '[data-testid="replay-turn-breakpoint"]'
    );
    expect(marker).not.toBeNull();

    act(() => {
      marker?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(80);
    });

    expect(
      document.body.querySelector(".native-tooltip-content-inner")?.textContent
    ).toBe(segments[1]?.tooltip);

    act(() => marker?.click());
    expect(onSegmentClick).toHaveBeenCalledOnce();
    expect(onSegmentClick).toHaveBeenCalledWith(segments[1]);
  });
});
