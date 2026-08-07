/**
 * Settings Configuration
 *
 * App settings sections. Labels use i18n keys under settings.sections.
 */
import {
  ChevronRight,
  type LucideIcon,
  SquareArrowOutUpRight,
} from "lucide-react";
import { createElement } from "react";

import { getSettingsSectionsByTab } from "@src/config/settingsUiManifest";

export interface SettingsSectionConfig {
  id: string;
  /** Translation key for the label (e.g., "general" -> t("sections.general")) */
  labelKey: string;
  icon: LucideIcon;
}

// ============================================
// App tab section IDs
// ============================================
export const SECTION_IDS = {
  GENERAL: "general",
  COLLABORATION: "collaboration",
  APPEARANCE: "appearance",
  EDITOR: "editor",
  SECURITY: "security",

  MONITOR: "monitor",
} as const;

// App sections (left sidebar items)
export const APP_SECTIONS: SettingsSectionConfig[] = getSettingsSectionsByTab(
  "app"
).map((section) => ({
  id: section.id,
  labelKey: section.labelKey,
  icon: section.icon,
}));

/**
 * Per-section sub-tab metadata for sections that expose URL-addressable
 * tabs. `key` matches the segment declared in `SETTINGS_SECTION_TABS`
 * (see `src/config/mainAppPaths/settings.ts`) so the URL and the tab
 * pill render in lockstep.
 *
 * Single source of truth — consumed by both the full Settings page and
 * the chat-panel `SettingsSlot` variant. Sections not listed here have
 * exactly one tab whose label is the section's title (the slot/page
 * fills that in from `getSettingsSectionById`).
 */
export interface SectionTabMeta {
  readonly key: string;
  readonly labelKey: string;
}

export const SECTION_TAB_META: Partial<
  Record<string, ReadonlyArray<SectionTabMeta>>
> = {
  [SECTION_IDS.GENERAL]: [
    { key: "general", labelKey: "general.tabGeneral" },
    { key: "notifications", labelKey: "sections.notifications" },
    { key: "shortcuts", labelKey: "shortcuts.title" },
  ],
  [SECTION_IDS.COLLABORATION]: [
    { key: "cloud", labelKey: "collaboration.tabs.cloud" },
    { key: "self-hosted", labelKey: "collaboration.tabs.selfHosted" },
  ],
  [SECTION_IDS.APPEARANCE]: [
    { key: "app", labelKey: "appearance.tabApp" },
    { key: "code-editor", labelKey: "appearance.tabCodeEditor" },
    { key: "chat-panel", labelKey: "appearance.tabChatPanel" },
  ],
  [SECTION_IDS.EDITOR]: [
    { key: "editor", labelKey: "editor.tabEditor" },
    { key: "index", labelKey: "editor.tabIndex" },
  ],
  [SECTION_IDS.MONITOR]: [
    { key: "resources", labelKey: "monitor.resourceUsage" },
    { key: "network", labelKey: "common:tabs.network" },
    { key: "storage", labelKey: "sections.storage" },
  ],
};

/** Shared props for buttons that navigate to a settings subpage */
export const SUBPAGE_BUTTON_PROPS = {
  variant: "secondary" as const,
  size: "default" as const,
  icon: createElement(ChevronRight, { size: 14 }),
  iconPosition: "right" as const,
};

/** Shared props for buttons that navigate to another page (outside settings) */
export const NAV_BUTTON_PROPS = {
  variant: "secondary" as const,
  size: "default" as const,
  icon: createElement(SquareArrowOutUpRight, { size: 14 }),
  iconPosition: "right" as const,
};
