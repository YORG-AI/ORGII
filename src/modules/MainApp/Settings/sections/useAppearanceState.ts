import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { APPLICATION_UI_FONT_IDS } from "@src/config/appearance/applicationUiFonts";
import {
  APPEARANCE_MODE,
  APPEARANCE_MODE_OPTIONS,
  GLOBAL_THEMES,
  THEME_PREFERENCE,
  getAppearanceModeForTheme,
  getDefaultThemePreferenceForAppearanceMode,
  getFollowSystemThemeLabel,
  getGlobalTheme,
  getThemeOptionsForAppearanceMode,
  normalizeAppearanceMode,
  normalizeGlobalThemePreference,
  resolveGlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import { PRIMARY_COLOR_PRESETS } from "@src/config/appearance/primaryColors";
import {
  UI_SCALE_CONFIG,
  applicationUiFontAtom,
  globalThemeIdAtom,
  primaryColorPresetAtom,
  spotlightPlacementAtom,
  systemColorSchemeAtom,
  uiScaleAtom,
  updateSettingsBatchAtom,
} from "@src/store";
import { swapThemeCss } from "@src/util/ui/theme/swapThemeCss";
import { showThemeTransitionCover } from "@src/util/ui/theme/themeTransitionCover";

const getApproxFontSize = (scale: number): string => {
  const baseFontSize = 14;
  const scaledSize = Math.round((baseFontSize * scale) / 100);
  return `${scaledSize}px`;
};

export const UI_SCALE_OPTIONS: number[] = [];
for (
  let scaleValue = UI_SCALE_CONFIG.MIN;
  scaleValue <= UI_SCALE_CONFIG.MAX;
  scaleValue += UI_SCALE_CONFIG.STEP
) {
  UI_SCALE_OPTIONS.push(scaleValue);
}

export function useAppearanceState() {
  const { t } = useTranslation("settings");

  const globalThemeId = useAtomValue(globalThemeIdAtom);
  const [primaryColorPreset, setPrimaryColorPreset] = useAtom(
    primaryColorPresetAtom
  );
  const [uiScale, setUIScale] = useAtom(uiScaleAtom);
  const [applicationUiFont, setApplicationUiFont] = useAtom(
    applicationUiFontAtom
  );
  const [spotlightPlacement, setSpotlightPlacement] = useAtom(
    spotlightPlacementAtom
  );
  const updateSettingsBatch = useSetAtom(updateSettingsBatchAtom);
  const systemColorScheme = useAtomValue(systemColorSchemeAtom);
  const followSystemThemeLabel = getFollowSystemThemeLabel(
    systemColorScheme,
    t("general.followSystem")
  );

  const appearanceMode = useMemo(
    () => getAppearanceModeForTheme(globalThemeId),
    [globalThemeId]
  );

  const handleThemeChange = useCallback(
    async (themeIdValue: string) => {
      const themePreference = normalizeGlobalThemePreference(themeIdValue);
      const resolvedThemeId = resolveGlobalThemePreference(themePreference);
      const selectedTheme = getGlobalTheme(resolvedThemeId);
      const cover = showThemeTransitionCover();
      try {
        await swapThemeCss(selectedTheme.baseCssPath);
        updateSettingsBatch({
          "general.theme": themePreference,
          "general.primaryColor": selectedTheme.defaultPrimaryColor,
        });
        localStorage.setItem("theme", themePreference);
      } finally {
        await cover.hide();
      }
    },
    [updateSettingsBatch]
  );

  const handleAppearanceModeChange = useCallback(
    async (value: string | number | (string | number)[]) => {
      const rawMode = String(Array.isArray(value) ? value[0] : value);
      const selectedMode = normalizeAppearanceMode(rawMode);
      await handleThemeChange(
        getDefaultThemePreferenceForAppearanceMode(selectedMode)
      );
    },
    [handleThemeChange]
  );

  const handleUIScaleChange = useCallback(
    (value: string) => {
      const scale = parseInt(value, 10);
      setUIScale(scale);
      const fontSize = getApproxFontSize(scale);
      Message.info({
        id: "ui-scale-message",
        content: `UI scale: ${scale}% · Font: ${fontSize}`,
        duration: 1500,
      });
    },
    [setUIScale]
  );

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

  const primaryColorOptions = useMemo(
    () =>
      PRIMARY_COLOR_PRESETS.map((preset) => ({
        label: t(`general.primaryColorOptions.${preset}`),
        value: preset,
      })),
    [t]
  );

  const applicationUiFontOptions = useMemo(
    () =>
      APPLICATION_UI_FONT_IDS.map((fontId) => ({
        label: t(`general.applicationFontOptions.${fontId}`),
        value: fontId,
      })),
    [t]
  );

  const themeOptions = useMemo(
    () =>
      getThemeOptionsForAppearanceMode(appearanceMode).map((themeId) => ({
        label:
          themeId === THEME_PREFERENCE.SYSTEM
            ? followSystemThemeLabel
            : t(GLOBAL_THEMES[themeId].i18nKey),
        value: themeId,
      })),
    [appearanceMode, followSystemThemeLabel, t]
  );

  return {
    globalThemeId,
    primaryColorPreset,
    setPrimaryColorPreset,
    uiScale,
    applicationUiFont,
    setApplicationUiFont,
    spotlightPlacement,
    setSpotlightPlacement,
    appearanceMode,
    appearanceModeOptions,
    themeOptions,
    primaryColorOptions,
    applicationUiFontOptions,
    handleThemeChange,
    handleAppearanceModeChange,
    handleUIScaleChange,
    getApproxFontSize,
  };
}
