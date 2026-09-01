/**
 * Settings Hooks
 *
 * Hooks for managing application settings, preferences, and cross-window sync.
 */

export {
  useCrossWindowSettingsSync,
  SETTINGS_CHANGED_EVENT,
} from "./useCrossWindowSettingsSync";

export {
  useEditorAppearanceSettings,
  useEditorAppearanceStyles,
} from "./useEditorAppearance";

export {
  useSetting,
  useSettingValue,
  useAllSettings,
  useSettingsLoaded,
  useUpdateSettingsBatch,
  useResetAllSettings,
  useSettingsJson,
} from "./useSettings";

export { useDevModeGuard } from "./useDevModeGuard";

export {
  applyPointerCursorPreference,
  POINTER_CURSORS_ATTRIBUTE,
  usePointerCursorPreference,
} from "./usePointerCursorPreference";

export { useSleepInhibitor } from "./useSleepInhibitor";

export {
  useLearningsBrowser,
  type LearningsBrowserFilters,
} from "./useLearningsBrowser";
