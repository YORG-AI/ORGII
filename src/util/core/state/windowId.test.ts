/**
 * Tests for getWindowId()'s defensive storage handling.
 *
 * Reproduces the "WKWebView privacy state throws SecurityError on sessionStorage
 * access, aborting first render" failure class. getWindowId() runs at
 * module-eval time through persisted repo/workspace atom keys inside the App's
 * synchronous import graph. An unguarded throw there would strand the user on
 * the splash. These tests pin the in-memory fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getWindowId } from "./windowId";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("getWindowId", () => {
  it("returns a persisted id and writes it back on first call", () => {
    const id = getWindowId();

    expect(id).toMatch(/^window-/);
    expect(sessionStorage.getItem("orgii-window-id")).toBe(id);
  });

  it("returns the same id across calls when storage works", () => {
    const first = getWindowId();
    const second = getWindowId();

    expect(second).toBe(first);
  });

  it("falls back to an in-memory id when sessionStorage.getItem throws", () => {
    vi.spyOn(sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    // Must not throw — this is the whole point (would otherwise abort render).
    const id = getWindowId();
    expect(id).toMatch(/^window-/);
  });

  it("returns a stable in-memory id across calls when storage is blocked", () => {
    vi.spyOn(sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    const first = getWindowId();
    const second = getWindowId();

    expect(first).toMatch(/^window-/);
    expect(second).toBe(first);
  });

  it("does not throw when sessionStorage.setItem throws on a fresh key", () => {
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => getWindowId()).not.toThrow();
  });
});
