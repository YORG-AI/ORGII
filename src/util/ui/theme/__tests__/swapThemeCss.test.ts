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

import { resolveNativeTheme, swapThemeCss } from "../swapThemeCss";

const { platform, setTheme } = vi.hoisted(() => ({
  platform: { macos: false, windows: false },
  setTheme: vi.fn(async (_theme: "light" | "dark" | null) => {}),
}));

vi.mock("@src/util/platform/tauri", () => ({
  isMacOS: () => platform.macos,
  isWindows: () => platform.windows,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme }),
}));
vi.mock("@src/util/platform/macosRootTint", () => ({
  syncMacosRootTint: vi.fn(async () => {}),
}));

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
  platform.macos = false;
  platform.windows = false;
  setTheme.mockClear();
  localStorage.removeItem("theme");
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

describe("resolveNativeTheme", () => {
  it("pins an explicit preference to the painted scheme", () => {
    expect(resolveNativeTheme("light", "light")).toBe("light");
    expect(resolveNativeTheme("dark", "dark")).toBe("dark");
  });

  it("leaves a follow-system preference unpinned", () => {
    expect(resolveNativeTheme("light", "system")).toBeNull();
    expect(resolveNativeTheme("dark", "system")).toBeNull();
  });
});

/**
 * The native appearance sync. On macOS Tauri's `setTheme` sets the app-wide
 * NSAppearance, which decides how AppKit draws the inactive traffic lights
 * (lightened under DarkAqua, darkened under Aqua) and what WKWebView reports
 * for `prefers-color-scheme`. These tests pin the contract: explicit
 * preferences pin the scheme, "follow system" passes `null`, Windows keeps
 * pinning the resolved scheme, and other hosts never call it.
 */
describe("syncThemeAppearance native theme", () => {
  async function syncActiveTheme(cssPath: string): Promise<void> {
    insertActiveThemeLink(cssPath);
    // Same-path swap: syncs the appearance synchronously, then the dynamic
    // window-API import and the setTheme call settle on the microtask queue.
    await swapThemeCss(cssPath);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("pins an explicit light preference on macOS", async () => {
    platform.macos = true;
    localStorage.setItem("theme", "light");

    await syncActiveTheme("/orgii_main.css");

    expect(setTheme).toHaveBeenCalledWith("light");
  });

  it("pins an explicit dark preference on macOS", async () => {
    platform.macos = true;
    localStorage.setItem("theme", "dark");

    await syncActiveTheme("/orgii_dark.css");

    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("follows the OS on macOS when the preference is system", async () => {
    platform.macos = true;
    localStorage.setItem("theme", "system");

    await syncActiveTheme("/orgii_dark.css");

    expect(setTheme).toHaveBeenCalledWith(null);
  });

  it("treats a missing stored preference as follow-system on macOS", async () => {
    platform.macos = true;

    await syncActiveTheme("/orgii_main.css");

    expect(setTheme).toHaveBeenCalledWith(null);
  });

  it("keeps pinning the painted scheme on Windows", async () => {
    platform.windows = true;
    localStorage.setItem("theme", "system");

    await syncActiveTheme("/orgii_main.css");

    expect(setTheme).toHaveBeenCalledWith("light");
  });

  it("never touches the native theme on other hosts", async () => {
    localStorage.setItem("theme", "dark");

    await syncActiveTheme("/orgii_dark.css");

    expect(setTheme).not.toHaveBeenCalled();
  });
});
