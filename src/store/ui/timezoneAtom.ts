/**
 * Timezone Atom
 *
 * Jotai atoms for timezone state management.
 * Backed by settings.jsonc via the central settingsAtom.
 * Types, options, and utilities are in @src/config/timezone.ts
 */
import { atom } from "jotai";

import type { TimezoneOption } from "@src/config/timezone";
import { settingsAtom, updateSettingAtom } from "@src/store/settings";

// Re-export types, options, and utilities from shared config
export type { TimezoneOption } from "@src/config/timezone";
export {
  getCurrentTimeForTimezone,
  getCurrentTimezone,
  getTimezoneOffset,
  TIMEZONE_OPTIONS,
} from "@src/config/timezone";

// ============================================
// Timezone Atoms (backed by settings.jsonc)
// ============================================

/**
 * Read/write timezone from the central settings.
 */
export const timezoneAtom = atom(
  (get) => get(settingsAtom)["general.timezone"] as TimezoneOption,
  (_get, set, value: TimezoneOption) => {
    set(updateSettingAtom, { key: "general.timezone", value });
    window.dispatchEvent(new Event("timezoneChange"));
  }
);
timezoneAtom.debugLabel = "timezoneAtom";
