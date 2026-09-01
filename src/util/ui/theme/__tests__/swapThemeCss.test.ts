// @vitest-environment jsdom
/**
 * Regression tests for the "OS switched appearance while the display was off"
 * bug: WKWebView pauses `requestAnimationFrame` for occluded windows (and can
 * leave it dead after system sleep), and `swapThemeCss` used to await two rAFs
 * *after* clearing its safety timeout — so a scheme flip delivered during
 * sleep stranded the swap forever: old+new stylesheets both attached,
 * `data-theme` never synced, and the caller's `.finally` (which hides the
 * transition cover) never ran.
 *
 * These tests pin the invariant: the swap promise settles and syncs the
 * appearance even when no animation frame ever fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { swapThemeCss } from "../swapThemeCss";

const THEME_LINK_SELECTOR = "link[data-orgii-theme]";

function insertActiveThemeLink(cssPath: string): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = cssPath;
  link.setAttribute("data-orgii-theme", "");
  document.head.appendChild(link);
  return link;
}

function themeLinks(): HTMLLinkElement[] {
  return Array.from(
    document.head.querySelectorAll<HTMLLinkElement>(THEME_LINK_SELECTOR)
  );
}

function findLink(cssPath: string): HTMLLinkElement {
  const link = themeLinks().find((candidate) =>
    candidate.href.endsWith(cssPath)
  );
  if (!link) throw new Error(`no theme link for ${cssPath}`);
  return link;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.head.querySelectorAll("link").forEach((link) => link.remove());
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeId;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("swapThemeCss with animation frames never firing", () => {
  beforeEach(() => {
    // Dead rAF: the occluded / post-sleep WKWebView state.
    vi.stubGlobal("requestAnimationFrame", () => 0);
  });

  it("promotes the loaded stylesheet and syncs the appearance", async () => {
    const oldLink = insertActiveThemeLink("/orgii_main.css");

    const swapPromise = swapThemeCss("/orgii_dark.css");
    findLink("/orgii_dark.css").onload?.(new Event("load"));

    await vi.advanceTimersByTimeAsync(1000);
    await swapPromise;

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themeId).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(oldLink.isConnected).toBe(false);
    expect(themeLinks()).toHaveLength(1);
  });

  it("settles a fresh-link swap and syncs the appearance", async () => {
    const swapPromise = swapThemeCss("/orgii_dark.css");
    findLink("/orgii_dark.css").onload?.(new Event("load"));

    await vi.advanceTimersByTimeAsync(1000);
    await swapPromise;

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeLinks()).toHaveLength(1);
  });

  it("keeps the old theme consistent when the load times out", async () => {
    const oldLink = insertActiveThemeLink("/orgii_dark.css");
    document.documentElement.dataset.theme = "dark";

    const swapPromise = swapThemeCss("/orgii_main.css");
    // Never fire onload: suspended load that misses the swap timeout.
    await vi.advanceTimersByTimeAsync(5000);
    await swapPromise;

    expect(oldLink.isConnected).toBe(true);
    expect(themeLinks()).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("swapThemeCss with working animation frames", () => {
  it("promotes exactly once when frames and the fallback timer race", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback): number => {
        callback(0);
        return 0;
      }
    );
    const oldLink = insertActiveThemeLink("/orgii_main.css");

    const swapPromise = swapThemeCss("/orgii_dark.css");
    findLink("/orgii_dark.css").onload?.(new Event("load"));

    // Let the (already-raced) fallback timer fire too: it must be a no-op.
    await vi.advanceTimersByTimeAsync(1000);
    await swapPromise;

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(oldLink.isConnected).toBe(false);
    expect(themeLinks()).toHaveLength(1);
  });
});
