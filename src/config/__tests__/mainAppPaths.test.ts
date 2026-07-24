import {
  SETTINGS_ROUTE_ROOT,
  buildIntegrationsPath,
  classifySettingsRouteRoot,
  deriveRouteCacheKey,
  parseIntegrationsPath,
} from "../mainAppPaths";

describe("Session Memory Embedding integrations route", () => {
  it("builds and parses the visible direct navigation path", () => {
    const path = buildIntegrationsPath({ category: "sessionMemoryEmbedding" });

    expect(path).toBe(
      "/orgii/app/settings/integrations/session-memory-embedding"
    );
    expect(parseIntegrationsPath(path).category).toBe(
      "sessionMemoryEmbedding"
    );
  });
});

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
