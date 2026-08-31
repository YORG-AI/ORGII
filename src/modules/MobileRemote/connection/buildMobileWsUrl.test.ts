import { describe, expect, it } from "vitest";

import { buildMobileWsUrl } from "./buildMobileWsUrl";

describe("buildMobileWsUrl", () => {
  it("uses explicit wsUrl when provided", () => {
    expect(
      buildMobileWsUrl({ wsUrl: "wss://relay.example.com/mobile/ws?token=abc" })
    ).toBe("wss://relay.example.com/mobile/ws?token=abc");
  });

  it("adds the Phase 1 device credential and pending pairing code", () => {
    expect(
      buildMobileWsUrl({
        wsUrl: "wss://relay.example.com/v1/mobile/ws",
        deviceToken: "device secret",
        pairingCode: "PAIR-1234",
      })
    ).toBe(
      "wss://relay.example.com/v1/mobile/ws?token=device+secret&pairingCode=PAIR-1234"
    );
  });

  it("builds LAN url from host port token", () => {
    expect(
      buildMobileWsUrl({ host: "192.168.1.10", port: 13847, token: "secret" })
    ).toBe("ws://192.168.1.10:13847/mobile/ws?token=secret");
  });

  it("throws when host missing", () => {
    expect(() => buildMobileWsUrl({ token: "x" })).toThrow(/host/i);
  });
});
