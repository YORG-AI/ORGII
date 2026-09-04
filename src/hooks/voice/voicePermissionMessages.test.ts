// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveVoicePermissionErrorMessage } from "./voicePermissionMessages";

describe("resolveVoicePermissionErrorMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the PWA settings path on iOS home-screen installs", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: true,
    });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("standalone"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    const message = resolveVoicePermissionErrorMessage(
      ((key: string) => key) as TFunction<"sessions", "input">
    );
    expect(message).toBe("voiceErrorPermissionIosPwa");
  });

  it("uses the Safari settings path in iOS browser tabs", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: false,
    });
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    const message = resolveVoicePermissionErrorMessage(
      ((key: string) => key) as TFunction<"sessions", "input">
    );
    expect(message).toBe("voiceErrorPermissionIosSafari");
  });
});
