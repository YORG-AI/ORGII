import {
  SETTINGS_ROUTE_ROOT,
  buildCodexReauthPath,
  classifySettingsRouteRoot,
  deriveRouteCacheKey,
  filterDevModeIntegrationItems,
  getDevOnlyIntegrationRedirect,
  isIntegrationCategoryAvailable,
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

describe("Codex reauthentication route", () => {
  it("opens the Key Vault wizard for the failed account and auto-starts OAuth", () => {
    const path = buildCodexReauthPath("account-123");

    expect(path).toBe(
      "/orgii/app/settings/integrations/models?wizard=key-add&id=account-123&reauth=codex&autoStart=true"
    );
    expect(parseCodexReauthIntent(path.split("?")[1])).toEqual({
      active: true,
      autoStart: true,
    });
  });

  it("does not activate for an ordinary Key Vault wizard", () => {
    expect(parseCodexReauthIntent("?wizard=key-add")).toEqual({
      active: false,
      autoStart: false,
    });
  });
});

describe("dev-only Settings integrations", () => {
  it("exposes Built-in Tools only in dev mode", () => {
    expect(isIntegrationCategoryAvailable("tools", false)).toBe(false);
    expect(isIntegrationCategoryAvailable("tools", true)).toBe(true);
    expect(isIntegrationCategoryAvailable("computerUse", false)).toBe(true);
  });

  it("filters Built-in Tools from mixed navigation lists", () => {
    const items = ["models", "tools", "computerUse"] as const;

    expect(filterDevModeIntegrationItems(items, false)).toEqual([
      "models",
      "computerUse",
    ]);
    expect(filterDevModeIntegrationItems(items, true)).toEqual(items);
  });

  it("redirects blocked direct links before the integration body mounts", () => {
    const toolsPath = "/orgii/app/settings/integrations/tools";

    expect(getDevOnlyIntegrationRedirect(toolsPath, false)).toBe(
      "/orgii/app/settings/integrations/models"
    );
    expect(getDevOnlyIntegrationRedirect(toolsPath, true)).toBeNull();
    expect(
      getDevOnlyIntegrationRedirect(
        "/orgii/app/settings/integrations/computerUse",
        false
      )
    ).toBeNull();
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
