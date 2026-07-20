import {
  SETTINGS_ROUTE_ROOT,
  buildCodexReauthPath,
  classifySettingsRouteRoot,
  deriveRouteCacheKey,
  parseCodexReauthIntent,
} from "../mainAppPaths";

describe("classifySettingsRouteRoot", () => {
  it("maps classic app settings paths to the Settings root", () => {
    expect(classifySettingsRouteRoot("/orgii/app/settings")).toBe(
      SETTINGS_ROUTE_ROOT.APP
    );
    expect(classifySettingsRouteRoot("/orgii/app/settings/appearance")).toBe(
      SETTINGS_ROUTE_ROOT.APP
    );
  });

  it("maps integrations and Agent Teams paths to their explicit roots", () => {
    expect(
      classifySettingsRouteRoot("/orgii/app/settings/integrations/tools")
    ).toBe(SETTINGS_ROUTE_ROOT.INTEGRATIONS);
    expect(
      classifySettingsRouteRoot("/orgii/app/settings/agent-orgs/agents")
    ).toBe(SETTINGS_ROUTE_ROOT.AGENT_ORGS);
    expect(
      classifySettingsRouteRoot("/orgii/app/settings/agent-orgs/orgs")
    ).toBe(SETTINGS_ROUTE_ROOT.AGENT_ORGS);
  });
});

describe("deriveRouteCacheKey", () => {
  it("keeps Settings cache keys split by React route root", () => {
    expect(deriveRouteCacheKey("/orgii/app/settings")).toBe("settings/app");
    expect(deriveRouteCacheKey("/orgii/app/settings/appearance")).toBe(
      "settings/app"
    );
    expect(deriveRouteCacheKey("/orgii/app/settings/integrations/tools")).toBe(
      "settings/integrations"
    );
    expect(deriveRouteCacheKey("/orgii/app/settings/agent-orgs/agents")).toBe(
      "settings/agent-orgs"
    );
    expect(deriveRouteCacheKey("/orgii/app/settings/agent-orgs/orgs")).toBe(
      "settings/agent-orgs"
    );
  });

  it("ignores query strings inside the same Settings route root", () => {
    expect(
      deriveRouteCacheKey(
        "/orgii/app/settings/integrations/tools?wizard=mcp-add"
      )
    ).toBe("settings/integrations");
  });
});

describe("Codex reauthentication route", () => {
  it("opens the KeyVault wizard for the failed account and auto-starts OAuth", () => {
    const path = buildCodexReauthPath("account-123");

    expect(path).toBe(
      "/orgii/app/settings/models?wizard=key-add&id=account-123&reauth=codex&autoStart=true"
    );
    expect(parseCodexReauthIntent(path.split("?")[1])).toEqual({
      active: true,
      autoStart: true,
    });
  });

  it("does not activate for an ordinary KeyVault wizard", () => {
    expect(parseCodexReauthIntent("?wizard=key-add")).toEqual({
      active: false,
      autoStart: false,
    });
  });
});
