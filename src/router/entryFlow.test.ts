// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { ROUTES } from "@src/config/routes";

import {
  LOGIN_REDIRECT_STORAGE_KEY,
  buildSetupEntryPath,
  consumeLoginRedirect,
  readLoginRedirect,
  resolvePostAuthRedirect,
  resolveSetupReturnPath,
  shouldAutoOpenSetup,
  storeLoginRedirect,
} from "./entryFlow";

describe("entryFlow", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("preserves pathname, query, and hash across authentication", () => {
    const target = {
      pathname: "/orgii/app/settings/appearance",
      search: "?source=deep-link",
      hash: "#themes",
    };

    expect(resolvePostAuthRedirect(target)).toBe(
      "/orgii/app/settings/appearance?source=deep-link#themes"
    );

    storeLoginRedirect(resolvePostAuthRedirect(target));
    expect(readLoginRedirect()).toBe(
      "/orgii/app/settings/appearance?source=deep-link#themes"
    );
    expect(consumeLoginRedirect()).toBe(
      "/orgii/app/settings/appearance?source=deep-link#themes"
    );
    expect(sessionStorage.getItem(LOGIN_REDIRECT_STORAGE_KEY)).toBeNull();
  });

  it("rejects external and public-auth redirect targets", () => {
    expect(resolvePostAuthRedirect("https://example.com/steal")).toBe(
      ROUTES.workStation.base.path
    );
    expect(resolvePostAuthRedirect("//example.com/steal")).toBe(
      ROUTES.workStation.base.path
    );
    expect(resolvePostAuthRedirect(ROUTES.auth.login.path)).toBe(
      ROUTES.workStation.base.path
    );
    expect(resolvePostAuthRedirect(ROUTES.app.market.callback.path)).toBe(
      ROUTES.workStation.base.path
    );
  });

  it("carries a safe return target through setup without shared window state", () => {
    const target = "/orgii/app/settings?tab=appearance#color";
    const setupPath = buildSetupEntryPath(target);
    const setupUrl = new URL(setupPath, "https://orgii.local");

    expect(setupUrl.pathname).toBe(ROUTES.auth.setup.path);
    expect(resolveSetupReturnPath(setupUrl.search)).toBe(target);
  });

  it("never lets setup return to auth or recursively to itself", () => {
    expect(buildSetupEntryPath(ROUTES.auth.setup.path)).toBe(
      ROUTES.auth.setup.path
    );
    expect(
      resolveSetupReturnPath(
        `?continue=${encodeURIComponent(ROUTES.auth.login.path)}`
      )
    ).toBe(ROUTES.workStation.base.path);
  });

  it("opens setup only after a successful settings hydration", () => {
    expect(
      shouldAutoOpenSetup({
        settingsLoaded: false,
        rawSettings: {},
        outcome: "open",
      })
    ).toBe(false);
    expect(
      shouldAutoOpenSetup({
        settingsLoaded: true,
        rawSettings: null,
        outcome: "open",
      })
    ).toBe(false);
    expect(
      shouldAutoOpenSetup({
        settingsLoaded: true,
        rawSettings: {},
        outcome: "open",
      })
    ).toBe(true);
    expect(
      shouldAutoOpenSetup({
        settingsLoaded: true,
        rawSettings: {},
        outcome: "completed",
      })
    ).toBe(false);
  });
});
