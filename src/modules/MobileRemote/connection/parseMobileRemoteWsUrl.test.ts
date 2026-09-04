import { describe, expect, it } from "vitest";

import { parseMobileRemoteWsUrl } from "./parseMobileRemoteWsUrl";

describe("parseMobileRemoteWsUrl", () => {
  it("rejects empty input", () => {
    expect(parseMobileRemoteWsUrl("   ")).toEqual({
      ok: false,
      errorKey: "pairing.errors.empty",
    });
  });

  it("parses Phase 0 LAN ws URL without SAS", () => {
    expect(
      parseMobileRemoteWsUrl("ws://192.168.1.10:13847/mobile/ws?token=secret")
    ).toEqual({
      ok: true,
      config: {
        wsUrl: "ws://192.168.1.10:13847/mobile/ws?token=secret",
        host: "192.168.1.10",
        port: 13847,
        token: "secret",
      },
      requiresSas: false,
    });
  });

  it("parses wss relay URL without SAS when no pairing code", () => {
    expect(
      parseMobileRemoteWsUrl("wss://relay.example.com/mobile/ws?token=abc")
    ).toMatchObject({
      ok: true,
      requiresSas: false,
      config: { wsUrl: "wss://relay.example.com/mobile/ws?token=abc" },
    });
  });

  it("parses Phase 1 JSON relay payload with SAS requirement", () => {
    expect(
      parseMobileRemoteWsUrl(
        JSON.stringify({
          v: 1,
          relayUrl: "wss://relay.example.com",
          pairingCode: "ABCD-1234",
          deviceToken: "device-secret",
          desktopId: "desktop-a",
          sasPhrase: "amber-falcon-42",
        })
      )
    ).toEqual({
      ok: true,
      config: {
        wsUrl: "wss://relay.example.com",
        deviceToken: "device-secret",
        pairingCode: "ABCD-1234",
        desktopId: "desktop-a",
      },
      requiresSas: true,
      sasPhrase: "amber-falcon-42",
    });
  });

  it("parses Phase 1 JSON host/port/token LAN shape", () => {
    expect(
      parseMobileRemoteWsUrl(
        JSON.stringify({
          v: 1,
          host: "192.168.0.5",
          port: 13847,
          token: "lan-token",
        })
      )
    ).toEqual({
      ok: true,
      config: {
        host: "192.168.0.5",
        port: 13847,
        token: "lan-token",
      },
      requiresSas: false,
    });
  });

  it("parses orgii deep link payload", () => {
    const payload = btoa(
      JSON.stringify({
        v: 1,
        relayUrl: "wss://relay.example.com",
        pairingCode: "PAIR-9999",
        deviceToken: "device-secret",
      })
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(
      parseMobileRemoteWsUrl(`orgii://mobile/pair?payload=${payload}`)
    ).toMatchObject({
      ok: true,
      requiresSas: true,
      config: {
        wsUrl: "wss://relay.example.com",
        deviceToken: "device-secret",
        pairingCode: "PAIR-9999",
      },
    });
  });

  it("parses a hosted PWA pairing fragment without sending the token to HTTP", () => {
    const payload = btoa(
      JSON.stringify({
        v: 1,
        relayUrl: "wss://relay.example.com/v1/mobile/ws",
        pairingCode: "PAIR-OUTDOOR",
        deviceToken: "device-secret",
        sasPhrase: "ocean-maple-kite",
      })
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      parseMobileRemoteWsUrl(
        `https://relay.example.com/orgii/mobile#pair=${payload}`
      )
    ).toMatchObject({
      ok: true,
      requiresSas: true,
      sasPhrase: "ocean-maple-kite",
      config: { deviceToken: "device-secret" },
    });
  });

  it("rejects unsupported protocol version", () => {
    expect(
      parseMobileRemoteWsUrl(JSON.stringify({ v: 2, relayUrl: "wss://x" }))
    ).toEqual({
      ok: false,
      errorKey: "pairing.errors.unsupportedVersion",
    });
  });

  it("rejects a relay payload without its device credential", () => {
    expect(
      parseMobileRemoteWsUrl(
        JSON.stringify({ v: 1, relayUrl: "wss://relay.example.com" })
      )
    ).toEqual({ ok: false, errorKey: "pairing.errors.invalid" });
  });

  it("rejects invalid JSON and non-ws strings", () => {
    expect(parseMobileRemoteWsUrl("{not-json")).toEqual({
      ok: false,
      errorKey: "pairing.errors.invalid",
    });
    expect(parseMobileRemoteWsUrl("https://example.com")).toEqual({
      ok: false,
      errorKey: "pairing.errors.invalid",
    });
  });
});
