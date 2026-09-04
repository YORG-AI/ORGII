import { describe, expect, it } from "vitest";

import {
  MOBILE_REMOTE_RELAY_LOCAL_URL,
  MOBILE_REMOTE_RELAY_PRODUCTION_URL,
  mobileRemoteRelayPresetUrl,
  resolveMobileRemoteRelayPreset,
} from "@src/config/mobileRemoteRelay";

describe("resolveMobileRemoteRelayPreset", () => {
  it("detects the local relay preset", () => {
    expect(resolveMobileRemoteRelayPreset(MOBILE_REMOTE_RELAY_LOCAL_URL)).toBe(
      "local"
    );
    expect(
      resolveMobileRemoteRelayPreset(` ${MOBILE_REMOTE_RELAY_LOCAL_URL} `)
    ).toBe("local");
  });

  it("detects the production relay preset", () => {
    expect(
      resolveMobileRemoteRelayPreset(MOBILE_REMOTE_RELAY_PRODUCTION_URL)
    ).toBe("production");
  });

  it("returns null for custom relay URLs", () => {
    expect(
      resolveMobileRemoteRelayPreset("wss://custom.example/v1/mobile/ws")
    ).toBeNull();
  });
});

describe("mobileRemoteRelayPresetUrl", () => {
  it("returns the configured preset URL", () => {
    expect(mobileRemoteRelayPresetUrl("local")).toBe(
      MOBILE_REMOTE_RELAY_LOCAL_URL
    );
    expect(mobileRemoteRelayPresetUrl("production")).toBe(
      MOBILE_REMOTE_RELAY_PRODUCTION_URL
    );
  });
});
