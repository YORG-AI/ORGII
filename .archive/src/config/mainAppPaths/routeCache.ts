import { parseCoreSettingsItem, parseSettingsTopTab } from "./settings";

export const SETTINGS_ROUTE_ROOT = {
  APP: "settings-app",
  INTEGRATIONS: "settings-integrations",
  AGENT_ORGS: "settings-agent-orgs",
  MY_ROLE: "settings-my-role",
} as const;

export type SettingsRouteRoot =
  (typeof SETTINGS_ROUTE_ROOT)[keyof typeof SETTINGS_ROUTE_ROOT];

const SETTINGS_ROUTE_CACHE_KEY: Record<SettingsRouteRoot, string> = {
  [SETTINGS_ROUTE_ROOT.APP]: "settings/app",
  [SETTINGS_ROUTE_ROOT.INTEGRATIONS]: "settings/integrations",
  [SETTINGS_ROUTE_ROOT.AGENT_ORGS]: "settings/agent-orgs",
  [SETTINGS_ROUTE_ROOT.MY_ROLE]: "settings/my-role",
};

export function classifySettingsRouteRoot(pathname: string): SettingsRouteRoot {
  const topTab = parseSettingsTopTab(pathname);
  if (topTab === "agent-orgs") return SETTINGS_ROUTE_ROOT.AGENT_ORGS;
  if (topTab === "integrations") return SETTINGS_ROUTE_ROOT.INTEGRATIONS;
  if (topTab === "my-role") return SETTINGS_ROUTE_ROOT.MY_ROLE;

  const { category } = parseCoreSettingsItem(pathname);
  return category ? SETTINGS_ROUTE_ROOT.INTEGRATIONS : SETTINGS_ROUTE_ROOT.APP;
}

export function deriveRouteCacheKey(pathname: string): string {
  const cleaned = pathname.split("?")[0].split("#")[0];
  const parts = cleaned.split("/").filter((segment) => segment.length > 0);

  let stripped: string[];
  if (parts[0] === "orgii" && parts[1] === "app") {
    stripped = parts.slice(2);
  } else {
    stripped = parts;
  }
  if (stripped.length === 0) return "root";

  const head = stripped[0];

  if (head === "settings") {
    const settingsPathname = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
    return SETTINGS_ROUTE_CACHE_KEY[
      classifySettingsRouteRoot(settingsPathname)
    ];
  }
  if (head === "market" && stripped.length >= 2) {
    return `market/${stripped[1]}`;
  }

  if (head === "home" && stripped.length >= 2) {
    return `home/${stripped[1]}`;
  }

  return head;
}
