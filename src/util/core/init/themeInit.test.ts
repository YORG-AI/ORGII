/**
 * Tests for theme initialization's appearance-sync contract.
 *
 * Reproduces the "chrome and content disagree on color scheme" bug:
 * `syncThemeAppearance` used to be called only from `link.onload`, so a slow or
 * failed stylesheet load left `data-theme` unwritten for the whole session.
 * Nothing else in the codebase writes that attribute, so every
 * `[data-theme="dark"]` rule stayed inert — and on Windows the native acrylic
 * backdrop kept the system scheme while the CSS used the opposite one.
 *
 * These tests pin the invariant: every resolve path syncs exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initTheme } from "./themeInit";

const syncThemeAppearance = vi.fn();
const preloadThemeCss = vi.fn();

vi.mock("@src/util/ui/theme/swapThemeCss", () => ({
  syncThemeAppearance: (cssPath: string) => syncThemeAppearance(cssPath),
  preloadThemeCss: (cssPaths: string[]) => preloadThemeCss(cssPaths),
}));

interface FakeLink {
  rel: string;
  type: string;
  href: string;
  onload: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  setAttribute: (name: string, value: string) => void;
}

let createdLinks: FakeLink[];

/** The stylesheet `initTheme` decided to load, without hardcoding the default. */
const requestedThemePath = (): string => createdLinks[0].href;

beforeEach(() => {
  vi.useFakeTimers();
  syncThemeAppearance.mockClear();
  preloadThemeCss.mockClear();
  createdLinks = [];
  localStorage.clear();

  const head = { firstChild: null, insertBefore: vi.fn() };

  // node's globalThis has no `document`; inject the narrow surface initTheme uses.
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: (): FakeLink => {
        const link: FakeLink = {
          rel: "",
          type: "",
          href: "",
          onload: null,
          onerror: null,
          setAttribute: vi.fn(),
        };
        createdLinks.push(link);
        return link;
      },
      querySelector: (selector: string) => (selector === "head" ? head : null),
      body: null,
    },
    configurable: true,
    writable: true,
  });

  // Run frame callbacks inline so the onload path settles without real frames.
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: (time: number) => void) => {
      callback(0);
      return 0;
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("initTheme appearance sync", () => {
  it("syncs the appearance when the stylesheet loads", async () => {
    const ready = initTheme();

    createdLinks[0].onload?.(new Event("load"));
    await ready;

    expect(syncThemeAppearance).toHaveBeenCalledTimes(1);
    expect(syncThemeAppearance).toHaveBeenCalledWith(requestedThemePath());
  });

  it("syncs the appearance when the stylesheet load times out", async () => {
    const ready = initTheme();
    const themePath = requestedThemePath();

    // Never fire onload: this is the slow-disk / cold-cache startup path.
    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    expect(syncThemeAppearance).toHaveBeenCalledTimes(1);
    expect(syncThemeAppearance).toHaveBeenCalledWith(themePath);
  });

  it("syncs the appearance when the stylesheet fails to load", async () => {
    const ready = initTheme();
    const themePath = requestedThemePath();

    createdLinks[0].onerror?.(new Event("error"));
    await ready;

    expect(syncThemeAppearance).toHaveBeenCalledTimes(1);
    expect(syncThemeAppearance).toHaveBeenCalledWith(themePath);
  });

  it("syncs once when a load races the timeout", async () => {
    const ready = initTheme();

    createdLinks[0].onload?.(new Event("load"));
    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    expect(syncThemeAppearance).toHaveBeenCalledTimes(1);
  });
});
