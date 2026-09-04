// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import i18n, { i18nReady } from "@src/i18n";
import enMobileRemote from "@src/i18n/locales/en/mobileRemote.json";

import { createBrowserMobileRemotePlatform } from "../platform/browser";
import {
  MobileRemoteDevelopmentRoot,
  resolveDevelopmentPairingUserId,
} from "./MobileRemoteDevelopmentRoot";

describe("MobileRemoteDevelopmentRoot", () => {
  it("enters the shared Mobile Remote app without constructing an auth client", async () => {
    await i18nReady;
    i18n.addResourceBundle("en", "mobileRemote", enMobileRemote, true, true);
    await i18n.changeLanguage("en");
    const platform = createBrowserMobileRemotePlatform();
    const createClient = vi.spyOn(platform.auth, "createClient");

    const markup = renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(MobileRemoteDevelopmentRoot, { platform })
      )
    );

    expect(markup).toContain("Mobile Remote");
    expect(markup).toContain("Try demo");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reuses the stored account scope when development has no own pairings", async () => {
    const platform = createBrowserMobileRemotePlatform();
    vi.spyOn(platform.connection, "listPairedDesktops").mockResolvedValue([]);
    vi.spyOn(platform.auth, "readSession").mockResolvedValue({
      kind: "org2_cloud",
      supabaseUrl: "https://cloud.example.test",
      supabaseAnonKey: "anon-key",
      userId: "user-a",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_900_000_000,
    });

    await expect(resolveDevelopmentPairingUserId(platform)).resolves.toBe(
      "user-a"
    );
  });

  it("keeps a populated development scope stable across later launches", async () => {
    const platform = createBrowserMobileRemotePlatform();
    vi.spyOn(platform.connection, "listPairedDesktops").mockResolvedValue([
      {
        id: "desktop-a",
        name: "Home Mac",
        updatedAtMs: 1_800_000_000_000,
        active: true,
      },
    ]);
    vi.spyOn(platform.auth, "readSession").mockResolvedValue({
      kind: "org2_cloud",
      supabaseUrl: "https://cloud.example.test",
      supabaseAnonKey: "anon-key",
      userId: "user-a",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_900_000_000,
    });

    await expect(resolveDevelopmentPairingUserId(platform)).resolves.toBe(
      "local-development"
    );
  });

  it("falls back to the stable development scope when Keychain reads fail", async () => {
    const platform = createBrowserMobileRemotePlatform();
    vi.spyOn(platform.connection, "listPairedDesktops").mockRejectedValue(
      new Error("keychain unavailable")
    );
    vi.spyOn(platform.auth, "readSession").mockRejectedValue(
      new Error("keychain unavailable")
    );

    await expect(resolveDevelopmentPairingUserId(platform)).resolves.toBe(
      "local-development"
    );
  });
});
