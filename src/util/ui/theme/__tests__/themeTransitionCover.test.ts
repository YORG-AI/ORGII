// @vitest-environment jsdom
/**
 * Regression tests for the stuck theme-transition cover: the full-screen
 * veil shown during a system theme swap used to depend on
 * `requestAnimationFrame` to fade out, so a scheme flip delivered while the
 * display was off (rAF paused/dead in WKWebView) left a pointer-blocking,
 * semi-transparent cover over the whole app until the user manually toggled
 * the OS appearance twice.
 *
 * Invariants pinned here: the cover always dies — with a dead rAF, without
 * `hide()` ever being called (max-lifetime failsafe), and it is never created
 * on a hidden document in the first place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showThemeTransitionCover } from "../themeTransitionCover";

const COVER_SELECTOR = "[data-orgii-theme-transition-cover]";

function coverElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(COVER_SELECTOR);
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Dead rAF: the occluded / post-sleep WKWebView state.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  setVisibilityState("visible");
  document.querySelectorAll(COVER_SELECTOR).forEach((node) => node.remove());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("showThemeTransitionCover", () => {
  it("hides the cover even when animation frames never fire", async () => {
    const handle = showThemeTransitionCover();
    expect(coverElement()).not.toBeNull();

    const hidePromise = handle.hide();
    await vi.advanceTimersByTimeAsync(2000);
    await hidePromise;

    expect(coverElement()).toBeNull();
  });

  it("stops intercepting pointer events as soon as the fade starts", async () => {
    const handle = showThemeTransitionCover();
    const wrapper = coverElement();
    expect(wrapper?.style.pointerEvents).toBe("auto");

    const hidePromise = handle.hide();
    // Past min-visible + frame fallback, inside the fade window.
    await vi.advanceTimersByTimeAsync(400);
    expect(wrapper?.style.pointerEvents).toBe("none");

    await vi.advanceTimersByTimeAsync(2000);
    await hidePromise;
  });

  it("self-destructs when hide is never called", async () => {
    showThemeTransitionCover();
    expect(coverElement()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(6000);

    expect(coverElement()).toBeNull();
  });

  it("does not create a cover on a hidden document", async () => {
    setVisibilityState("hidden");

    const handle = showThemeTransitionCover();

    expect(coverElement()).toBeNull();
    await expect(handle.hide()).resolves.toBeUndefined();
  });

  it("adopts an existing cover so a later swap can hide it", async () => {
    showThemeTransitionCover();
    const adopted = showThemeTransitionCover();

    expect(document.querySelectorAll(COVER_SELECTOR)).toHaveLength(1);

    const hidePromise = adopted.hide();
    await vi.advanceTimersByTimeAsync(2000);
    await hidePromise;

    expect(coverElement()).toBeNull();
  });
});
