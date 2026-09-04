/**
 * Settings Store
 *
 * VS Code-style settings system backed by `~/.orgii/settings.jsonc`.
 *
 * Public API:
 * - `useSetting(key)` — Read/write a single setting
 * - `useSettingValue(key)` — Read-only access to a setting
 * - `useAllSettings()` — Read the full settings object
 * - `useSettingsSync()` — Initialize and listen for file changes (call once)
 * - `settingAtom(key)` — Create a read-only Jotai atom for a setting
 */

// Atoms
export {
  settingsAtom,
  settingsLoadedAtom,
  settingAtom,
  updateSettingAtom,
  saveSettingAtom,
  updateSettingsBatchAtom,
  resetAllSettingsAtom,
  initSettingsAtom,
  handleExternalChangeAtom,
  handleFileDeletedAtom,
} from "./settingsAtom";

// Hooks (canonical location: @src/hooks/settings/useSettings)
export {
  useSetting,
  useSettingValue,
  useAllSettings,
} from "@src/hooks/settings/useSettings";

// Sync (file watcher listener)
export { useSettingsSync } from "./settingsSync";
