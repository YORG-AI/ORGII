/**
 * Settings Hooks
 *
 * Hooks for managing application settings, preferences, and cross-window sync.
 */

export {
  useCrossWindowSettingsSync,
  useSettingChangeListener,
  SETTINGS_CHANGED_EVENT,
  type SettingsChangedEvent,
} from "./useCrossWindowSettingsSync";

export {
  useEditorAppearanceSettings,
  useEditorAppearanceStyles,
  type EditorAppearanceSettings,
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
  type UseLearningsBrowserReturn,
  type LearningsBrowserFilters,
} from "./useLearningsBrowser";
