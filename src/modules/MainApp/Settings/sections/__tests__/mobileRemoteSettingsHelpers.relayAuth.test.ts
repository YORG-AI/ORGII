import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import {
  formatMobileRemoteRelayStatusMessage,
  isMobileRemoteRelayReady,
  usesLocalRelayDesktopToken,
} from "../mobileRemoteSettingsHelpers";

describe("mobileRemoteSettingsHelpers relay auth", () => {
  const t = ((key: string) => key) as TFunction<"settings">;

  it("treats only the local preset URL as desktop-token auth", () => {
    expect(usesLocalRelayDesktopToken("ws://127.0.0.1:8787/v1/mobile/ws")).toBe(
      true
    );
    expect(
      usesLocalRelayDesktopToken(
        "wss://orgii-mobile-relay.superficial-jasper.workers.dev/v1/mobile/ws"
      )
    ).toBe(false);
    expect(
      usesLocalRelayDesktopToken("wss://custom.example.test/v1/mobile/ws")
    ).toBe(false);
  });

  it("requires ORG2 Cloud login for production relay readiness", () => {
    expect(
      isMobileRemoteRelayReady({
        relayUrl: "wss://relay.example.test/v1/mobile/ws",
        desktopToken: "",
        cloudSignedIn: false,
      })
    ).toBe(false);
    expect(
      isMobileRemoteRelayReady({
        relayUrl: "wss://relay.example.test/v1/mobile/ws",
        desktopToken: "",
        cloudSignedIn: true,
      })
    ).toBe(true);
  });

  it("maps auth failures to ORG2 Cloud guidance on production relay", () => {
    expect(
      formatMobileRemoteRelayStatusMessage(
        "connect to relay: HTTP error: 401 Unauthorized",
        "wss://relay.example.test/v1/mobile/ws",
        false,
        t
      )
    ).toBe("mobileRemote.relayStatusCloudLoginRequired");
  });

  it("maps legacy desktop token config errors to cloud login guidance", () => {
    expect(
      formatMobileRemoteRelayStatusMessage(
        "desktop relay token must contain at least 24 characters",
        "wss://relay.example.test/v1/mobile/ws",
        false,
        t
      )
    ).toBe("mobileRemote.relayStatusCloudLoginRequired");
  });

  it("maps local token failures to the desktop key hint", () => {
    expect(
      formatMobileRemoteRelayStatusMessage(
        "invalid desktop token",
        "ws://127.0.0.1:8787/v1/mobile/ws",
        false,
        t
      )
    ).toBe("mobileRemote.relayStatusLocalTokenInvalid");
  });
});
