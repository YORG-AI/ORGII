// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  mapGetUserMediaError,
  queryMicrophonePermission,
  requestMicrophoneAccess,
} from "./requestMicrophoneAccess";

describe("requestMicrophoneAccess", () => {
  it("maps NotAllowedError to denied", () => {
    expect(
      mapGetUserMediaError(
        Object.assign(new Error("blocked"), { name: "NotAllowedError" })
      )
    ).toBe("denied");
  });

  it("maps NotFoundError to unsupported", () => {
    expect(
      mapGetUserMediaError(
        Object.assign(new Error("missing"), { name: "NotFoundError" })
      )
    ).toBe("unsupported");
  });

  it("stops tracks after a successful grant", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    await expect(requestMicrophoneAccess()).resolves.toBe("granted");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("maps permissions.query denied to denied", async () => {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "denied" }),
      },
    });

    await expect(queryMicrophonePermission()).resolves.toBe("denied");
  });
});
