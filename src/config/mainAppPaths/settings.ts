import {
  INTEGRATIONS_CATEGORIES,
  type IntegrationsCategorySegment,
  buildIntegrationsPath,
  fromCategoryUrlSegment,
} from "./integrations";
import { SETTINGS_BASE, settingsPathParts } from "./shared";

export type SettingsSectionSegment =
  | "general"
  | "collaboration"
  | "appearance"
  | "editor"
  | "security"
  | "update"
  | "monitor";

export type SettingsSubpageSegment = "editor-appearance";

export const SETTINGS_SECTIONS: readonly SettingsSectionSegment[] = [
  "general",
  "collaboration",
  "appearance",
  "editor",
  "security",
  "update",
  "monitor",
] as const;

export const SETTINGS_SUBPAGES: readonly SettingsSubpageSegment[] = [
  "editor-appearance",
] as const;

export const SETTINGS_SECTION_TABS = {
  general: ["general", "notifications", "shortcuts"],
  collaboration: ["cloud", "self-hosted"],
  appearance: ["app", "code-editor", "chat-panel"],
  editor: ["editor", "index"],
  monitor: ["resources", "network", "storage"],
} as const satisfies Partial<Record<SettingsSectionSegment, readonly string[]>>;

export type SettingsSectionWithTabs = keyof typeof SETTINGS_SECTION_TABS;

export type SettingsSectionTab<S extends SettingsSectionWithTabs> =
  (typeof SETTINGS_SECTION_TABS)[S][number];

export type SettingsTopTabSegment =
  | "core-settings"
  | "integrations"
  | "agent-orgs"
  | "agents"
  | "org"
  | "clis"
  | "my-role";

export const SETTINGS_TOP_TABS: readonly SettingsTopTabSegment[] = [
  "core-settings",
  "integrations",
  "agent-orgs",
  "my-role",
] as const;

export type CoreSettingsItemSegment =
  | SettingsSectionSegment
  | IntegrationsCategorySegment;

export interface SettingsPathOptions {
  section?: SettingsSectionSegment;
  tab?: string;
  subpage?: SettingsSubpageSegment;
}

export function buildSettingsPath(options: SettingsPathOptions = {}): string {
  const { section, tab, subpage } = options;

  if (subpage) {
    return `${SETTINGS_BASE}/subpage/${subpage}`;
  }

  if (section) {
    const tabSegment = tab ? `/${tab}` : "";
    return `${SETTINGS_BASE}/app/${section}${tabSegment}`;
  }

  return SETTINGS_BASE;
}

export function parseCoreSettingsItem(pathname: string): {
  section: SettingsSectionSegment | null;
  category: IntegrationsCategorySegment | null;
} {
  const parts = settingsPathParts(pathname);

  const itemPart =
    parts[0] === "core-settings" ||
    parts[0] === "app-settings" ||
    parts[0] === "app" ||
    parts[0] === "integrations"
      ? parts[1]
      : parts[0];

  if (!itemPart) return { section: null, category: null };

  let normalized = fromCategoryUrlSegment(itemPart);
  if (normalized === "notifications" || normalized === "shortcuts") {
    normalized = "general";
  }
  if (normalized === "code-search-indexing" || normalized === "workspace") {
    normalized = "editor";
  }

  if ((SETTINGS_SECTIONS as readonly string[]).includes(normalized)) {
    return { section: normalized as SettingsSectionSegment, category: null };
  }
  if ((INTEGRATIONS_CATEGORIES as readonly string[]).includes(normalized)) {
    return {
      section: null,
      category: normalized as IntegrationsCategorySegment,
    };
  }
  return { section: null, category: null };
}

export function parseSettingsSectionTab(pathname: string): {
  section: SettingsSectionSegment | null;
  tab: string | null;
} {
  const parts = settingsPathParts(pathname);

  const startsWithTopTab =
    parts[0] === "core-settings" ||
    parts[0] === "app-settings" ||
    parts[0] === "app" ||
    parts[0] === "integrations";
  const itemPart = startsWithTopTab ? parts[1] : parts[0];
  const tabPart = startsWithTopTab ? parts[2] : parts[1];

  if (!itemPart) return { section: null, tab: null };

  if (itemPart === "notifications" || itemPart === "shortcuts") {
    return { section: "general", tab: itemPart };
  }

  if (itemPart === "code-search-indexing" || itemPart === "workspace") {
    return { section: "editor", tab: "index" };
  }

  const { section } = parseCoreSettingsItem(pathname);
  if (!section) return { section: null, tab: null };

  if (!(section in SETTINGS_SECTION_TABS)) {
    return { section, tab: null };
  }

  const validTabs = SETTINGS_SECTION_TABS[
    section as SettingsSectionWithTabs
  ] as readonly string[];
  if (tabPart && validTabs.includes(tabPart)) {
    return { section, tab: tabPart };
  }
  return { section, tab: null };
}

export function getDefaultSettingsSectionTab(
  section: SettingsSectionSegment
): string | null {
  if (!(section in SETTINGS_SECTION_TABS)) return null;
  return SETTINGS_SECTION_TABS[section as SettingsSectionWithTabs][0];
}

export function parseSettingsPath(pathname: string): {
  section: SettingsSectionSegment | null;
  subpage: SettingsSubpageSegment | null;
} {
  const parts = settingsPathParts(pathname);

  if (parts[0] === "subpage") {
    const rawSubpage = parts[1];
    const subpage: SettingsSubpageSegment | null = (
      SETTINGS_SUBPAGES as readonly string[]
    ).includes(rawSubpage ?? "")
      ? (rawSubpage as SettingsSubpageSegment)
      : null;
    return { section: null, subpage };
  }

  return { section: parseCoreSettingsItem(pathname).section, subpage: null };
}

export function parseSettingsTopTab(pathname: string): SettingsTopTabSegment {
  const head = settingsPathParts(pathname)[0];
  if (head === "subpage") return "core-settings";
  if (head === "integrations") return "integrations";
  if (head === "agent-orgs") return "agent-orgs";
  if (head === "agents" || head === "org" || head === "clis") {
    return "agent-orgs";
  }
  if (head === "my-role") return "my-role";
  return "core-settings";
}

export function buildSettingsTabPath(tab: SettingsTopTabSegment): string {
  if (tab === "core-settings") return SETTINGS_BASE;
  if (tab === "integrations") return buildIntegrationsPath();
  if (tab === "agent-orgs" || tab === "agents") {
    return `${SETTINGS_BASE}/agent-orgs/agents`;
  }
  if (tab === "org") return `${SETTINGS_BASE}/agent-orgs/orgs`;
  if (tab === "clis") return `${SETTINGS_BASE}/agent-orgs/clis`;
  return `${SETTINGS_BASE}/${tab}`;
}

export function buildCoreSettingsItemPath(
  item: CoreSettingsItemSegment
): string {
  if ((INTEGRATIONS_CATEGORIES as readonly string[]).includes(item)) {
    return buildIntegrationsPath({
      category: item as IntegrationsCategorySegment,
    });
  }
  return `${SETTINGS_BASE}/app/${item}`;
}
