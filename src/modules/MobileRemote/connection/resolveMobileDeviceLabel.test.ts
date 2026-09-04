import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMobileDeviceLabel } from "./resolveMobileDeviceLabel";

describe("resolveMobileDeviceLabel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects iPhone user agents", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
    });
    expect(resolveMobileDeviceLabel()).toBe("iPhone");
  });

  it("detects Android model names", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36",
      platform: "Linux armv8l",
    });
    expect(resolveMobileDeviceLabel()).toBe("Pixel 8 Pro");
  });

  it("detects desktop browsers used for QA", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36",
      platform: "MacIntel",
    });
    expect(resolveMobileDeviceLabel()).toBe("Mac browser");
  });
});
