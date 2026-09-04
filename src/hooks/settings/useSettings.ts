/**
 * Settings Hooks
 *
 * Convenient hooks for reading and writing individual settings.
 *
 * Usage:
 *   const [fontSize, setFontSize] = useSetting("editor.fontSize");
 *   setFontSize(16);
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import type {
  SettingValue,
  SettingsKey,
  SettingsObject,
} from "@src/config/settingsSchema";
import {
  settingAtom,
  settingsAtom,
  updateSettingAtom,
} from "@src/store/settings/settingsAtom";

/**
 * Read and write a single setting.
 *
 * Returns a tuple `[value, setValue]` similar to `useState`.
 * Uses `settingAtom(key)` for granular subscriptions — only re-renders
 * when this specific key changes, not when any setting changes.
 *
 * @example
 * ```tsx
 * const [fontSize, setFontSize] = useSetting("editor.fontSize");
 * <Slider value={fontSize} onValueChange={setFontSize} />
 * ```
 */
export function useSetting<K extends SettingsKey>(
  key: K
): [SettingValue<K>, (value: SettingValue<K>) => void] {
  const value = useAtomValue(settingAtom(key));
  const updateSetting = useSetAtom(updateSettingAtom);

  const setValue = useCallback(
    (newValue: SettingValue<K>) => {
      updateSetting({ key, value: newValue });
    },
    [key, updateSetting]
  );

  return [value, setValue];
}

/**
 * Read a single setting value (read-only, no setter).
 * Uses `settingAtom(key)` for granular subscriptions — only re-renders
 * when this specific key changes, not when any setting changes.
 *
 * @example
 * ```tsx
 * const theme = useSettingValue("general.theme");
 * ```
 */
export function useSettingValue<K extends SettingsKey>(
  key: K
): SettingValue<K> {
  return useAtomValue(settingAtom(key));
}

/**
 * Read the full settings object.
 */
export function useAllSettings(): SettingsObject {
  return useAtomValue(settingsAtom);
}
