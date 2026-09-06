/**
 * useBackgroundSettings Hook
 * Handles solid background and appearance customization.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Message from "@src/components/Message";
import {
  BACKGROUND_COLOR_PRESETS,
  getBackgroundColorPresetById,
  resolveBackgroundColorPreset,
} from "@src/config/appearance/backgroundColors";
import {
  APPEARANCE_MODE,
  APPEARANCE_MODE_OPTIONS,
  type AppearanceMode,
  getAppearanceModeForTheme,
  getDefaultThemePreferenceForAppearanceMode,
  getFollowSystemThemeLabel,
  getGlobalTheme,
  normalizeAppearanceMode,
  normalizeGlobalThemePreference,
  resolveGlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import { getSkinsForVariant } from "@src/config/appearance/skins/registry";
import type { SkinVariant } from "@src/config/appearance/skins/types";
import { buildSettingsPath } from "@src/config/mainAppPaths";
import { useUndoStackWithRestore } from "@src/hooks/ui";
import {
  backgroundConfigPersistAtom,
  darkSkinIdAtom,
  globalThemeIdAtom,
  lightSkinIdAtom,
  systemColorSchemeAtom,
  updateSettingsBatchAtom,
} from "@src/store";
import {
  type BackgroundConfig,
  sanitizePageOpacity,
  sanitizeSidebarOpacity,
} from "@src/store/ui/backgroundConfigAtom";
import { prewarmColor } from "@src/util/ui/theme/glassMaterial";
import { swapThemeCss } from "@src/util/ui/theme/swapThemeCss";
import { showThemeTransitionCover } from "@src/util/ui/theme/themeTransitionCover";

import { MAX_CUSTOM_BACKGROUND_COLORS } from "../config";
import { normalizeHexColor } from "../utils";

export interface UseBackgroundSettingsReturn {
  // State
  config: BackgroundConfig;
  globalThemeId: string;
  isDarkTheme: boolean;
  appearanceMode: AppearanceMode;
  appearanceModeOptions: { label: string; value: AppearanceMode }[];
  skinOptions: { label: string; value: string }[];
  activeSkinId: string;
  handleSkinChange: (value: string | number | (string | number)[]) => void;

  // Handlers
  handleBack: () => void;
  handleColorSelect: (presetId: string) => void;
  handleSelectCustomPaletteHex: (hex: string) => void;
  handleAddCustomPaletteHex: (hex: string) => void;
  handleRemoveCustomPaletteHex: (hex: string, event: React.MouseEvent) => void;
  handlePageOpacityChange: (val: number | number[]) => void;
  handleSidebarOpacityChange: (val: number | number[]) => void;
  handleAppearanceModeChange: (
    value: string | number | (string | number)[]
  ) => void;
}

export function useBackgroundSettings(): UseBackgroundSettingsReturn {
  const navigate = useNavigate();
  const { t } = useTranslation("settings");
  const [config, setConfig] = useAtom(backgroundConfigPersistAtom);
  const globalThemeId = useAtomValue(globalThemeIdAtom);
  const [lightSkinId, setLightSkinId] = useAtom(lightSkinIdAtom);
  const [darkSkinId, setDarkSkinId] = useAtom(darkSkinIdAtom);
  const systemColorScheme = useAtomValue(systemColorSchemeAtom);
  const followSystemThemeLabel = getFollowSystemThemeLabel(
    systemColorScheme,
    t("general.followSystem")
  );
  const updateSettingsBatch = useSetAtom(updateSettingsBatchAtom);
  const isDarkTheme = getGlobalTheme(globalThemeId).isDark;
  const appearanceMode = getAppearanceModeForTheme(globalThemeId);

  const appearanceModeOptions = useMemo(
    () =>
      APPEARANCE_MODE_OPTIONS.map((mode) => ({
        label:
          mode === APPEARANCE_MODE.SYSTEM
            ? followSystemThemeLabel
            : t(`general.${mode}`),
        value: mode,
      })),
    [followSystemThemeLabel, t]
  );

  // Each appearance mode now resolves to exactly one stylesheet, so the second
  // dropdown offers skins for the live variant instead of restating the mode.
  const skinVariant: SkinVariant = isDarkTheme ? "dark" : "light";
  const activeSkinId = skinVariant === "dark" ? darkSkinId : lightSkinId;

  const skinOptions = useMemo(
    () =>
      getSkinsForVariant(skinVariant).map((skin) => ({
        label: skin.label,
        value: skin.id,
      })),
    [skinVariant]
  );

  useEffect(() => {
    if (!config.backgroundColorId) return;
    const preset = getBackgroundColorPresetById(config.backgroundColorId);
    if (!preset) return;
    prewarmColor(resolveBackgroundColorPreset(preset));
  }, [config.backgroundColorId]);

  // Undo/redo for config changes (Ctrl+Z / Cmd+Z)
  const undoStack = useUndoStackWithRestore<BackgroundConfig>({
    keyboardShortcut: true,
    currentValue: config,
    onRestore: (prev) => setConfig(prev),
  });

  const setConfigWithUndo = useCallback(
    (next: BackgroundConfig) => {
      undoStack.snapshot(config);
      setConfig(next);
    },
    [config, setConfig, undoStack]
  );

  // Handlers
  const handleBack = useCallback(() => {
    navigate(buildSettingsPath({ section: "appearance" }));
  }, [navigate]);

  const handleColorSelect = useCallback(
    (presetId: string) => {
      const preset = getBackgroundColorPresetById(presetId);
      if (!preset) return;
      setConfigWithUndo({
        ...config,
        backgroundColor: resolveBackgroundColorPreset(preset),
        backgroundColorId: preset.id,
      });
    },
    [config, setConfigWithUndo]
  );

  const handleSelectCustomPaletteHex = useCallback(
    (hex: string) => {
      const normalized = normalizeHexColor(hex);
      if (!normalized) return;
      setConfigWithUndo({
        ...config,
        backgroundColor: normalized,
        backgroundColorId: undefined,
      });
    },
    [config, setConfigWithUndo]
  );

  const handleAddCustomPaletteHex = useCallback(
    (hex: string) => {
      const normalized = normalizeHexColor(hex);
      if (!normalized) return;
      const current = [...(config.customColors ?? [])];
      const exists = current.some(
        (entry) => normalizeHexColor(entry) === normalized
      );
      let nextList = current;
      if (!exists) {
        if (current.length >= MAX_CUSTOM_BACKGROUND_COLORS) {
          Message.warning(
            t("background.customColorsLimit", {
              max: MAX_CUSTOM_BACKGROUND_COLORS,
            })
          );
          return;
        }
        nextList = [...current, normalized];
      }
      setConfigWithUndo({
        ...config,
        customColors: nextList,
        backgroundColor: normalized,
        backgroundColorId: undefined,
      });
    },
    [config, setConfigWithUndo, t]
  );

  const handleRemoveCustomPaletteHex = useCallback(
    (hex: string, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const normalizedRemove = normalizeHexColor(hex);
      if (!normalizedRemove) return;
      const nextList = (config.customColors ?? []).filter(
        (entry) => normalizeHexColor(entry) !== normalizedRemove
      );
      const activeHex =
        config.backgroundColor && !config.backgroundColorId
          ? normalizeHexColor(config.backgroundColor)
          : null;
      const removingActive =
        activeHex !== null && activeHex === normalizedRemove;

      let nextConfig: BackgroundConfig = {
        ...config,
        customColors: nextList,
      };

      if (removingActive) {
        const firstPreset = BACKGROUND_COLOR_PRESETS[0];
        if (firstPreset) {
          nextConfig = {
            ...nextConfig,
            backgroundColor: resolveBackgroundColorPreset(firstPreset),
            backgroundColorId: firstPreset.id,
          };
        }
      }

      setConfigWithUndo(nextConfig);
    },
    [config, setConfigWithUndo]
  );

  const handlePageOpacityChange = useCallback(
    (val: number | number[]) => {
      const raw = Array.isArray(val) ? val[0] : val;
      const pageOpacity = sanitizePageOpacity(raw);
      setConfigWithUndo({ ...config, pageOpacity });
    },
    [config, setConfigWithUndo]
  );

  const handleSidebarOpacityChange = useCallback(
    (val: number | number[]) => {
      const raw = Array.isArray(val) ? val[0] : val;
      const sidebarOpacity = sanitizeSidebarOpacity(raw);
      setConfigWithUndo({ ...config, sidebarOpacity });
    },
    [config, setConfigWithUndo]
  );

  const applyThemeChange = useCallback(
    async (themeIdValue: string) => {
      const themePreference = normalizeGlobalThemePreference(themeIdValue);
      const resolvedThemeId = resolveGlobalThemePreference(themePreference);
      const selectedTheme = getGlobalTheme(resolvedThemeId);
      const cover = showThemeTransitionCover();
      try {
        await swapThemeCss(selectedTheme.baseCssPath);
        updateSettingsBatch({
          "general.theme": themePreference,
        });
        localStorage.setItem("theme", themePreference);
      } finally {
        await cover.hide();
      }
    },
    [updateSettingsBatch]
  );

  const handleSkinChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const skinId = String(Array.isArray(value) ? value[0] : value);
      if (skinVariant === "dark") setDarkSkinId(skinId);
      else setLightSkinId(skinId);
    },
    [skinVariant, setDarkSkinId, setLightSkinId]
  );

  const handleAppearanceModeChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const rawMode = String(Array.isArray(value) ? value[0] : value);
      const selectedMode = normalizeAppearanceMode(rawMode);
      applyThemeChange(
        getDefaultThemePreferenceForAppearanceMode(selectedMode)
      );
    },
    [applyThemeChange]
  );

  return {
    // State
    config,
    globalThemeId,
    isDarkTheme,
    appearanceMode,
    appearanceModeOptions,
    skinOptions,
    activeSkinId,
    handleSkinChange,
    // Handlers
    handleBack,
    handleColorSelect,
    handleSelectCustomPaletteHex,
    handleAddCustomPaletteHex,
    handleRemoveCustomPaletteHex,
    handlePageOpacityChange,
    handleSidebarOpacityChange,
    handleAppearanceModeChange,
  };
}
