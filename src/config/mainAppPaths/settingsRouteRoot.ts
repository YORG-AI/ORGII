import { parseCoreSettingsItem, parseSettingsTopTab } from "./settings";

export const SETTINGS_ROUTE_ROOT = {
  APP: "settings-app",
  INTEGRATIONS: "settings-integrations",
  AGENT_ORGS: "settings-agent-orgs",
  MY_ROLE: "settings-my-role",
} as const;

export type SettingsRouteRoot =
  (typeof SETTINGS_ROUTE_ROOT)[keyof typeof SETTINGS_ROUTE_ROOT];

export function classifySettingsRouteRoot(pathname: string): SettingsRouteRoot {
  const topTab = parseSettingsTopTab(pathname);
  if (topTab === "agent-orgs") return SETTINGS_ROUTE_ROOT.AGENT_ORGS;
  if (topTab === "integrations") return SETTINGS_ROUTE_ROOT.INTEGRATIONS;
  if (topTab === "my-role") return SETTINGS_ROUTE_ROOT.MY_ROLE;

  const { category } = parseCoreSettingsItem(pathname);
  return category ? SETTINGS_ROUTE_ROOT.INTEGRATIONS : SETTINGS_ROUTE_ROOT.APP;
}
