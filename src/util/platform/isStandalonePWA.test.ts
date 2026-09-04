// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { isStandalonePWA } from "./isStandalonePWA";

describe("isStandalonePWA", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true for iOS home-screen standalone mode", () => {
    vi.stubGlobal("navigator", { standalone: true });
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    expect(isStandalonePWA()).toBe(true);
  });

  it("returns true when display-mode is standalone", () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("standalone"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    expect(isStandalonePWA()).toBe(true);
  });
});
