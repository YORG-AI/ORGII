import {
  SETTINGS_REGISTRY,
  type SettingsKey,
} from "@src/config/settingsSchema";

import { AGENT_SETTINGS_UI_SECTIONS } from "./sections/agent";
import { APP_SETTINGS_UI_SECTIONS } from "./sections/app";
import { INTEGRATIONS_SETTINGS_UI_SECTIONS } from "./sections/integrations";
import type { SettingsSectionDefinition, SettingsTabId } from "./types";

/**
 * Single source for settings navigation and section rendering metadata.
 * Sections can be fully declarative (containers/rows) or custom-slot based.
 */
const SETTINGS_UI_SECTIONS: SettingsSectionDefinition[] = [
  ...APP_SETTINGS_UI_SECTIONS,
  ...AGENT_SETTINGS_UI_SECTIONS,
  ...INTEGRATIONS_SETTINGS_UI_SECTIONS,
];

export function getSettingsSectionsByTab(
  tab: SettingsTabId
): SettingsSectionDefinition[] {
  return SETTINGS_UI_SECTIONS.filter((section) => section.tab === tab);
}

export function getSettingsSectionById(
  sectionId: string
): SettingsSectionDefinition | undefined {
  return SETTINGS_UI_SECTIONS.find((section) => section.id === sectionId);
}

export function getManifestCoveredKeys(): SettingsKey[] {
  const keySet = new Set<SettingsKey>();

  SETTINGS_UI_SECTIONS.forEach((section) => {
    section.coveredKeys?.forEach((key) => keySet.add(key));

    section.containers?.forEach((container) => {
      container.rows.forEach((row) => {
        if (row.kind === "field") {
          keySet.add(row.key);
        }
      });
    });
  });

  return [...keySet];
}

export function getUnknownManifestKeys(): string[] {
  const registryKeys = new Set(Object.keys(SETTINGS_REGISTRY));
  return getManifestCoveredKeys().filter((key) => !registryKeys.has(key));
}
