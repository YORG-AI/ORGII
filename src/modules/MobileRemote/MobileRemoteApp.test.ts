import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import i18n, { i18nReady } from "@src/i18n";
import enMobileRemote from "@src/i18n/locales/en/mobileRemote.json";

import { MobileRemoteApp } from "./MobileRemoteApp";

describe("MobileRemoteApp", () => {
  it("renders welcome markup within providers", async () => {
    await i18nReady;
    i18n.addResourceBundle("en", "mobileRemote", enMobileRemote, true, true);
    await i18n.changeLanguage("en");
    const markup = renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(MobileRemoteApp, { authUserId: "user-a" })
      )
    );
    expect(markup).toContain("Mobile Remote");
    expect(markup).toContain("Try demo");
  });
});
