/**
 * Settings Schema
 *
 * Defines every user-facing setting with Zod validation, defaults, and descriptions.
 * Uses flat dot-notation keys (like VS Code's `editor.fontSize`).
 *
 * This is the single source of truth for:
 * - Setting keys and their types
 * - Default values
 * - Descriptions (used for JSONC comments + GUI tooltips)
 * - JSON Schema generation (for autocomplete in external editors)
 */
import { z } from "zod";

import { SETTINGS_CATEGORY_LABELS, SETTINGS_REGISTRY } from "./registry";
import type { SettingsCategory } from "./types";

export type { SettingDefinition, SettingsCategory } from "./types";

// ============================================
// Derived Types
// ============================================

/** All valid setting keys */
export type SettingsKey = keyof typeof SETTINGS_REGISTRY;

/** Type of a specific setting value */
export type SettingValue<K extends SettingsKey> = z.infer<
  (typeof SETTINGS_REGISTRY)[K]["schema"]
>;

/** Complete settings object (all keys with their values) */
export type SettingsObject = {
  [K in SettingsKey]: SettingValue<K>;
};

// ============================================
// Utility Functions
// ============================================

/** Get all default values as a flat object */
export function getSettingsDefaults(): SettingsObject {
  const defaults = {} as Record<string, unknown>;
  for (const [key, definition] of Object.entries(SETTINGS_REGISTRY)) {
    defaults[key] = definition.default;
  }
  return defaults as SettingsObject;
}

/** Get all setting keys */
export function getSettingsKeys(): SettingsKey[] {
  return Object.keys(SETTINGS_REGISTRY) as SettingsKey[];
}

const CHAT_PANEL_POSITION_KEY = "general.chatPanelPosition";
const LEGACY_CHAT_PANEL_POSITION_KEYS = [
  "general.workStationChatPosition",
  "general.sessionChatPosition",
] as const;

function migrateLegacyChatPanelPosition(
  partial: Record<string, unknown>
): Record<string, unknown> {
  const normalized = { ...partial };

  if (!(CHAT_PANEL_POSITION_KEY in normalized)) {
    const positionSchema = SETTINGS_REGISTRY[CHAT_PANEL_POSITION_KEY].schema;
    for (const legacyKey of LEGACY_CHAT_PANEL_POSITION_KEYS) {
      const parsed = positionSchema.safeParse(partial[legacyKey]);
      if (parsed.success) {
        normalized[CHAT_PANEL_POSITION_KEY] = parsed.data;
        break;
      }
    }
  }

  for (const legacyKey of LEGACY_CHAT_PANEL_POSITION_KEYS) {
    delete normalized[legacyKey];
  }

  return normalized;
}

/**
 * Validate a partial settings object.
 * Returns the validated values merged with defaults, or throws on invalid values.
 */
export function validateSettings(
  partial: Record<string, unknown>
): SettingsObject {
  const defaults = getSettingsDefaults();
  const result = { ...defaults };
  const normalized = migrateLegacyChatPanelPosition(partial);

  for (const [key, value] of Object.entries(normalized)) {
    if (key === "$schema") continue; // Skip JSON Schema reference

    const definition = SETTINGS_REGISTRY[key as SettingsKey];
    if (!definition) {
      // Unknown key — skip silently (forward compatibility)
      continue;
    }

    const parsed = definition.schema.safeParse(value);
    if (parsed.success) {
      (result as Record<string, unknown>)[key] = parsed.data;
    }
    // Invalid values are silently replaced with defaults
  }

  return result;
}

/**
 * Generate JSONC content with comments from the current settings.
 * Each setting gets a comment with its description.
 */
export function generateJsoncContent(settings: SettingsObject): string {
  const lines: string[] = [
    "{",
    "  // NOTE: This file only includes schema-backed settings.",
    "  // Some Settings UI sections are managed by other systems and are not represented here.",
    "  // Not covered in this JSON: network, dependencies, monitor, storage,",
    "  // and Agent sections: cli-config, agent-tools, agent-skills, agent-connectivity.",
  ];

  // Group settings by category for better readability
  const categories = new Map<SettingsCategory, [string, unknown, string][]>();

  for (const key of getSettingsKeys()) {
    const definition = SETTINGS_REGISTRY[key];
    const value = (settings as Record<string, unknown>)[key];
    const category = definition.category;

    if (!categories.has(category)) {
      categories.set(category, []);
    }
    categories.get(category)!.push([key, value, definition.description]);
  }

  const categoryEntries = [...categories.entries()];
  for (
    let categoryIndex = 0;
    categoryIndex < categoryEntries.length;
    categoryIndex++
  ) {
    const [category, entries] = categoryEntries[categoryIndex];
    const isLastCategory = categoryIndex === categoryEntries.length - 1;

    lines.push("");
    lines.push(`  // --- ${SETTINGS_CATEGORY_LABELS[category]} ---`);

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const [key, value, description] = entries[entryIndex];
      const isLastEntry = isLastCategory && entryIndex === entries.length - 1;
      const comma = isLastEntry ? "" : ",";

      lines.push(`  // ${description}`);
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    }
  }

  lines.push("}");
  lines.push(""); // trailing newline
  return lines.join("\n");
}

export { SETTINGS_CATEGORY_LABELS, SETTINGS_REGISTRY };
