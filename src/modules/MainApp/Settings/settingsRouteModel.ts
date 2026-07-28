import {
  type SettingsSectionSegment,
  type SettingsSubpageSegment,
  buildSettingsPath,
  getDefaultSettingsSectionTab,
  parseCoreSettingsItem,
  parseSettingsPath,
  parseSettingsSectionTab,
} from "@src/config/mainAppPaths";

import { APP_SECTIONS, SECTION_IDS } from "./config";

interface SettingsRouteState {
  activeSection: SettingsSectionSegment;
  activeSectionTab: string;
  subpage: SettingsSubpageSegment | null;
  canonicalPath: string | null;
}

export function resolveSettingsRoute(pathname: string): SettingsRouteState {
  const parsedPath = parseSettingsPath(pathname);
  const activeSection = resolveActiveSection(parsedPath.section);
  const { tab } = parseSettingsSectionTab(pathname);
  const activeSectionTab =
    tab ?? getDefaultSettingsSectionTab(activeSection) ?? activeSection;

  return {
    activeSection,
    activeSectionTab,
    subpage: parsedPath.subpage,
    canonicalPath: resolveCanonicalSettingsPath(pathname),
  };
}

function resolveActiveSection(
  section: SettingsSectionSegment | null
): SettingsSectionSegment {
  if (section && APP_SECTIONS.some((candidate) => candidate.id === section)) {
    return section;
  }
  return (APP_SECTIONS[0]?.id ?? SECTION_IDS.GENERAL) as SettingsSectionSegment;
}

function resolveCanonicalSettingsPath(pathname: string): string | null {
  const parsedPath = parseSettingsPath(pathname);
  if (parsedPath.subpage) return null;

  const { section: sectionTab, tab } = parseSettingsSectionTab(pathname);
  const { section, category } = parseCoreSettingsItem(pathname);
  const parts = pathname.split("/").filter(Boolean);
  const tail = parts.at(-1);

  if (
    sectionTab === "general" &&
    tab &&
    (tail === "notifications" || tail === "shortcuts")
  ) {
    return buildSettingsPath({ section: "general", tab });
  }

  if (
    sectionTab === "editor" &&
    tab === "index" &&
    (tail === "code-search-indexing" || tail === "workspace")
  ) {
    return buildSettingsPath({ section: "editor", tab: "index" });
  }

  if (section || category || isBareSettingsLanding(tail)) return null;
  return buildSettingsPath({ section: resolveActiveSection(null) });
}

function isBareSettingsLanding(tail: string | undefined): boolean {
  return (
    tail === undefined ||
    tail === "settings" ||
    tail === "core-settings" ||
    tail === "app-settings" ||
    tail === "integrations"
  );
}
