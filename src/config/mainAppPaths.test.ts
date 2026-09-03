import { ContentWritingIcon, ContrastIcon } from "@src/icons";

import {
  SETTINGS_ROUTE_ROOT,
  SETTINGS_SECTION_TABS,
  buildCodexReauthPath,
  classifySettingsRouteRoot,
  filterDevModeIntegrationItems,
  getDefaultSettingsSectionTab,
  getDevOnlyIntegrationRedirect,
  getPathIcon,
  getSegmentIcon,
  isIntegrationCategoryAvailable,
  parseCodexReauthIntent,
  parseSettingsSectionTab,
} from "./mainAppPaths";

describe("My Station Code Editor icon", () => {
  it("uses the writing glyph in path-derived navigation", () => {
    expect(getPathIcon("/orgii/workstation/code")).toBe(ContentWritingIcon);
  });
});

describe("Settings sidebar icons", () => {
  it("uses the contrast glyph for Appearance", () => {
    expect(getSegmentIcon("appearance")).toBe(ContrastIcon);
  });
});

describe("General settings tabs", () => {
  it("keeps Self-hosted as the final General tab", () => {
    expect(SETTINGS_SECTION_TABS.general).toEqual([
      "general",
      "notifications",
      "shortcuts",
      "self-hosted",
    ]);
    expect(getDefaultSettingsSectionTab("general")).toBe("general");
  });

  it("keeps Collaboration bookmarks pointed at their new General tabs", () => {
    expect(
      parseSettingsSectionTab("/orgii/app/settings/app/collaboration/cloud")
    ).toEqual({ section: "general", tab: "general" });
    expect(
      parseSettingsSectionTab(
        "/orgii/app/settings/app/collaboration/self-hosted"
      )
    ).toEqual({ section: "general", tab: "self-hosted" });
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
