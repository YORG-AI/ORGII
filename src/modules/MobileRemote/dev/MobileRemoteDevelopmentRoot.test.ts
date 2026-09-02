// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import i18n, { i18nReady } from "@src/i18n";
import enMobileRemote from "@src/i18n/locales/en/mobileRemote.json";

import { createBrowserMobileRemotePlatform } from "../platform/browser";
import { MobileRemoteDevelopmentRoot } from "./MobileRemoteDevelopmentRoot";

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
});
