// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveVerticalFit } from "./positioning";
import { DROPDOWN_PANEL } from "./tokens";

const VIEWPORT_HEIGHT = 800;
const GAP = DROPDOWN_PANEL.triggerGapTight;
const PADDING = DROPDOWN_PANEL.viewportPadding;

function stubViewportHeight(height: number): void {
  vi.stubGlobal("innerHeight", height);
  vi.stubGlobal("innerWidth", 1200);
}

/** Trigger whose top edge sits `top` px down the viewport, 24px tall. */
function makeTrigger(top: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ top, bottom: top + 24 }),
  } as unknown as HTMLElement;
}

/** Panel that reports `height` both rendered and unclamped. */
function makePanel(height: number, renderedHeight = height): HTMLElement {
  return {
    getBoundingClientRect: () => ({ height: renderedHeight }),
    scrollHeight: height,
  } as unknown as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveVerticalFit", () => {
  it("keeps the requested side when the panel fits below", () => {
    stubViewportHeight(VIEWPORT_HEIGHT);

    const fit = resolveVerticalFit({
      position: "bottom-start",
      triggerElement: makeTrigger(100),
      panelElement: makePanel(200),
    });

    expect(fit.position).toBe("bottom-start");
    expect(fit.constrained).toBe(false);
    expect(fit.maxHeight).toBe(VIEWPORT_HEIGHT - 124 - GAP - PADDING);
  });

  it("flips upward when the space above is larger", () => {
    stubViewportHeight(VIEWPORT_HEIGHT);

    // Trigger near the bottom: ~76px below, ~688px above.
    const fit = resolveVerticalFit({
      position: "bottom-start",
      triggerElement: makeTrigger(700),
      panelElement: makePanel(300),
    });

    expect(fit.position).toBe("top-start");
    expect(fit.constrained).toBe(false);
    expect(fit.maxHeight).toBe(700 - GAP - PADDING);
  });

  it("flips downward for an upward placement pinned to the top edge", () => {
    stubViewportHeight(VIEWPORT_HEIGHT);

    const fit = resolveVerticalFit({
      position: "top-end",
      triggerElement: makeTrigger(20),
      panelElement: makePanel(300),
    });

    expect(fit.position).toBe("bottom-end");
  });

  it("stays put and constrains when neither side fits", () => {
    stubViewportHeight(400);

    // Trigger centred: ~188px above, ~188px below, panel wants 600px.
    const fit = resolveVerticalFit({
      position: "bottom-start",
      triggerElement: makeTrigger(188),
      panelElement: makePanel(600),
    });

    expect(fit.position).toBe("bottom-start");
    expect(fit.constrained).toBe(true);
    expect(fit.maxHeight).toBe(400 - 212 - GAP - PADDING);
  });

  it("never shrinks the budget below the usable floor", () => {
    // Short viewport with the trigger centred: ~78px above, ~74px below,
    // so the winning side is still narrower than the floor.
    stubViewportHeight(200);

    const fit = resolveVerticalFit({
      position: "bottom-start",
      triggerElement: makeTrigger(90),
      panelElement: makePanel(300),
    });

    expect(fit.position).toBe("top-start");
    expect(fit.maxHeight).toBe(DROPDOWN_PANEL.minAvailableHeight);
  });

  it("uses the unclamped content height so an applied cap cannot re-decide the side", () => {
    stubViewportHeight(VIEWPORT_HEIGHT);

    // Rendered height is already clamped to 76px by a previous pass, but the
    // content still wants 300px — the panel must still flip upward.
    const fit = resolveVerticalFit({
      position: "bottom-start",
      triggerElement: makeTrigger(700),
      panelElement: makePanel(300, 76),
    });

    expect(fit.position).toBe("top-start");
  });

  it("leaves side placements alone", () => {
    stubViewportHeight(VIEWPORT_HEIGHT);

    const fit = resolveVerticalFit({
      position: "right-start",
      triggerElement: makeTrigger(700),
      panelElement: makePanel(600),
    });

    expect(fit.position).toBe("right-start");
    expect(fit.constrained).toBe(false);
    expect(fit.maxHeight).toBe(DROPDOWN_PANEL.maxHeight);
  });

  it("assumes an estimated height before the panel mounts", () => {
    stubViewportHeight(VIEWPORT_HEIGHT);

    const fit = resolveVerticalFit({
      position: "bottom-start",
      triggerElement: makeTrigger(700),
      panelElement: null,
    });

    // 240px estimate does not fit in the ~76px below, so it still flips.
    expect(fit.position).toBe("top-start");
    // ...but nothing is constrained until a real panel has been measured.
    expect(fit.constrained).toBe(false);
  });
});
