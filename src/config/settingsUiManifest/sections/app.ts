import { type RenderableIcon } from "@src/components/AnyIcon";
import { getSegmentIcon } from "@src/config/mainAppPaths";
import { type SettingsKey, getSettingsKeys } from "@src/config/settingsSchema";
import { SETTINGS_SECTION_SLOT_IDS } from "@src/config/settingsUiManifest/slotIds";
import type { SettingsSectionDefinition } from "@src/config/settingsUiManifest/types";

/**
 * All app-settings sidebar icons come from the central
 * {@link SEGMENT_REGISTRY} keyed by the same URL segment used in the
 * route (e.g. `/orgii/app/settings/appearance` → `"appearance"`).
 * This guarantees the sidebar glyph matches the breadcrumb and the
 * Global Spotlight destination entry.
 */
function iconForSegment(segment: string): RenderableIcon {
  const icon = getSegmentIcon(segment);
  if (!icon) {
    throw new Error(
      `APP_SETTINGS_UI_SECTIONS: missing icon for segment "${segment}"`
    );
  }
  return icon;
}

function keysByPrefixes(prefixes: string[]): SettingsKey[] {
  const keys = getSettingsKeys();
  return keys.filter((key) =>
    prefixes.some((prefix) => key.startsWith(prefix))
  ) as SettingsKey[];
}

const MY_ROLE_SETTING_KEYS = [
  "general.presenceGuidanceOnline",
  "general.presenceGuidanceInvisible",
  "general.presenceGuidanceAway",
  "general.profileTechSavvy",
  "general.profileJobRoles",
  "general.profileFamiliarTechStacks",
  "general.profileDescription",
] as const satisfies readonly SettingsKey[];

// Rendered by the dedicated Security section (not General), so exclude them
// from General's prefix-based coverage to keep parity 1:1 with the UI.
const SECURITY_SECTION_KEYS = [
  "general.secretScanEnabled",
  "general.secretScanEntropyEnabled",
  "general.secretScanCustomPatterns",
] as const satisfies readonly SettingsKey[];

const GENERAL_SECTION_KEYS: SettingsKey[] = [
  ...keysByPrefixes(["general.", "notifications.", "privacy."]).filter(
    (key) =>
      !(MY_ROLE_SETTING_KEYS as readonly string[]).includes(key) &&
      !(SECURITY_SECTION_KEYS as readonly string[]).includes(key)
  ),
  "network.httpVersion",
] as SettingsKey[];
const APPEARANCE_SECTION_KEYS = keysByPrefixes([
  "background.",
  "sidebar.",
  "layout.",
  "chat.",
]);
const EDITOR_SECTION_KEYS = keysByPrefixes([
  "editor.",
  "terminal.",
  "workspace.",
  "git.",
]);
const MONITOR_SECTION_KEYS = keysByPrefixes(["network."]);
export const APP_SETTINGS_UI_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    tab: "app",
    labelKey: "general",
    headingTitleKey: "sections.general",
    icon: iconForSegment("general"),
    customSectionSlotId: SETTINGS_SECTION_SLOT_IDS.APP_GENERAL,
    coveredKeys: GENERAL_SECTION_KEYS,
  },
  {
    id: "collaboration",
    tab: "app",
    labelKey: "collaboration",
    headingTitleKey: "sections.collaboration",
    icon: iconForSegment("collaboration"),
    customSectionSlotId: SETTINGS_SECTION_SLOT_IDS.APP_COLLABORATION,
    coveredKeys: [],
  },
  {
    id: "appearance",
    tab: "app",
    labelKey: "appearance",
    headingTitleKey: "sections.appearance",
    icon: iconForSegment("appearance"),
    customSectionSlotId: SETTINGS_SECTION_SLOT_IDS.APP_APPEARANCE,
    coveredKeys: APPEARANCE_SECTION_KEYS,
  },
  {
    id: "editor",
    tab: "app",
    labelKey: "editorAndWorkspace",
    headingTitleKey: "sections.editorAndWorkspace",
    icon: iconForSegment("editor"),
    customSectionSlotId: SETTINGS_SECTION_SLOT_IDS.APP_EDITOR,
    // `coveredKeys` only describes the Editor-tab settings
    // (terminal / git / lsp).
    coveredKeys: EDITOR_SECTION_KEYS,
  },
  {
    id: "security",
    tab: "app",
    labelKey: "security",
    headingTitleKey: "sections.security",
    icon: iconForSegment("security"),
    customSectionSlotId: SETTINGS_SECTION_SLOT_IDS.APP_SECURITY,
    coveredKeys: [...SECURITY_SECTION_KEYS],
  },
  {
    id: "monitor",
    tab: "app",
    labelKey: "monitor",
    headingTitleKey: "sections.monitor",
    icon: iconForSegment("monitor"),
    customSectionSlotId: SETTINGS_SECTION_SLOT_IDS.APP_MONITOR,
    coveredKeys: MONITOR_SECTION_KEYS,
  },
];
