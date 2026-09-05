// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRANSIENT_SCROLLBAR_ATTRIBUTE,
  TRANSIENT_SCROLLBAR_HIDE_DELAY_MS,
  TRANSIENT_SCROLLBAR_OWNER_ATTRIBUTE,
  clearTransientScrollbar,
  installTransientScrollbars,
  observeTransientScrollbar,
  revealTransientScrollbar,
} from "../transientScrollbars";

describe("transient scrollbar activity", () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    dispose = installTransientScrollbars();
  });

  afterEach(() => {
    dispose();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reveals only in response to scrolling and hides after inactivity", () => {
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);

    scroller.dispatchEvent(new Event("mouseenter"));
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);

    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(true);

    vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS);
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never reveals an explicitly hidden scrollbar", () => {
    const scroller = document.createElement("div");
    scroller.className = "scrollbar-hide";
    document.body.appendChild(scroller);

    scroller.dispatchEvent(new Event("scroll"));

    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces a scroll burst into one bounded hide timer", () => {
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);

    scroller.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS - 100);
    scroller.dispatchEvent(new Event("scroll"));
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(100);
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(TRANSIENT_SCROLLBAR_HIDE_DELAY_MS - 100);
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("installs only one observer for the document", () => {
    expect(installTransientScrollbars()).toBe(dispose);
  });

  it("moves visibility to the latest scroll area", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);

    first.dispatchEvent(new Event("scroll"));
    second.dispatchEvent(new Event("scroll"));

    expect(first.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);
    expect(second.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("routes third-party internal scroll events to their visual owner", () => {
    const owner = document.createElement("div");
    const internalScroller = document.createElement("div");
    owner.setAttribute(TRANSIENT_SCROLLBAR_OWNER_ATTRIBUTE, "");
    owner.appendChild(internalScroller);
    document.body.appendChild(owner);

    internalScroller.dispatchEvent(new Event("scroll"));

    expect(owner.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(true);
    expect(internalScroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(
      false
    );
  });

  it("shares the same activity state with custom overlay scrollbars", () => {
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);

    revealTransientScrollbar(overlay);
    expect(overlay.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(true);

    clearTransientScrollbar(overlay);
    expect(overlay.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bridges and disposes isolated shadow-root scrollers", () => {
    const host = document.createElement("div");
    const scroller = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.appendChild(scroller);
    document.body.appendChild(host);
    const stopObserving = observeTransientScrollbar(scroller);

    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(true);

    stopObserving();
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);
  });

  it("clears active work while hidden and fully disposes listeners", () => {
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    scroller.dispatchEvent(new Event("scroll"));

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    dispose();
    scroller.dispatchEvent(new Event("scroll"));
    expect(scroller.hasAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE)).toBe(false);

    dispose = installTransientScrollbars();
  });
});
