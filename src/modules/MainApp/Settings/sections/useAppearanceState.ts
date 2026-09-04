import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import type { SelectOptionGroup } from "@src/components/Select/types";
import { APPLICATION_UI_FONT_IDS } from "@src/config/appearance/applicationUiFonts";
import {
  APPEARANCE_MODE,
  APPEARANCE_MODE_OPTIONS,
  getAppearanceModeForTheme,
  getDefaultThemePreferenceForAppearanceMode,
  getFollowSystemThemeLabel,
  getGlobalTheme,
  normalizeAppearanceMode,
  normalizeGlobalThemePreference,
  resolveGlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import {
  ACCENT_PRESETS,
  type AccentPreset,
  getAccentSwatch,
} from "@src/config/appearance/skins/accent";
import {
  getSkinSeed,
  getSkinsForVariant,
  getUnifiedSkins,
  supportsBothVariants,
} from "@src/config/appearance/skins/registry";
import type { SkinVariant } from "@src/config/appearance/skins/types";
import {
  UI_SCALE_CONFIG,
  activeSkinIdAtom,
  applicationUiFontAtom,
  darkAccentPresetAtom,
  darkSkinIdAtom,
  globalThemeIdAtom,
  iconStyleAtom,
  lightAccentPresetAtom,
  lightSkinIdAtom,
  linkSkinVariantsAtom,
  skinVariantAtom,
  spotlightPlacementAtom,
  systemColorSchemeAtom,
  translucentSidebarAtom,
  uiScaleAtom,
  updateSettingsBatchAtom,
} from "@src/store";
import { swapThemeCss } from "@src/util/ui/theme/swapThemeCss";
import { showThemeTransitionCover } from "@src/util/ui/theme/themeTransitionCover";

import { AccentSwatch, SkinSwatch } from "./SkinSwatch";

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
  const [uiScale, setUIScale] = useAtom(uiScaleAtom);
  const [applicationUiFont, setApplicationUiFont] = useAtom(
    applicationUiFontAtom
  );
  const [spotlightPlacement, setSpotlightPlacement] = useAtom(
    spotlightPlacementAtom
  );
  const [linkSkinVariants, setLinkSkinVariants] = useAtom(linkSkinVariantsAtom);
  const [lightSkinId, setLightSkinId] = useAtom(lightSkinIdAtom);
  const [darkSkinId, setDarkSkinId] = useAtom(darkSkinIdAtom);
  const [lightAccent, setLightAccent] = useAtom(lightAccentPresetAtom);
  const [darkAccent, setDarkAccent] = useAtom(darkAccentPresetAtom);
  const [iconStyle, setIconStyle] = useAtom(iconStyleAtom);
  const [translucentSidebar, setTranslucentSidebar] = useAtom(
    translucentSidebarAtom
  );
  const skinVariant = useAtomValue(skinVariantAtom);
  const activeSkinId = useAtomValue(activeSkinIdAtom);
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

  /**
   * Skins are grouped by origin so ORGII's own designs stay at the top of a
   * list that Codex otherwise dominates by count.
   */
  const buildSkinOptions = useCallback(
    (variant: SkinVariant): SelectOptionGroup[] => {
      const skins = getSkinsForVariant(variant);
      const toOption = (skin: (typeof skins)[number]) => ({
        label: skin.label,
        value: skin.id,
        icon: React.createElement(SkinSwatch, { skinId: skin.id, variant }),
      });
      const groups: SelectOptionGroup[] = [];
      const orgii = skins.filter((skin) => skin.source === "orgii");
      const codex = skins.filter((skin) => skin.source === "codex");
      if (orgii.length > 0) {
        groups.push({
          label: t("general.skinGroups.orgii"),
          options: orgii.map(toOption),
        });
      }
      if (codex.length > 0) {
        groups.push({
          label: t("general.skinGroups.codex"),
          options: codex.map(toOption),
        });
      }
      return groups;
    },
    [t]
  );

  const lightSkinOptions = useMemo(
    () => buildSkinOptions("light"),
    [buildSkinOptions]
  );
  const darkSkinOptions = useMemo(
    () => buildSkinOptions("dark"),
    [buildSkinOptions]
  );

  const buildAccentOptions = useCallback(
    (variant: SkinVariant, skinId: string) => {
      const seed = getSkinSeed(skinId, variant);
      return ACCENT_PRESETS.map((preset) => ({
        label: t(`general.primaryColorOptions.${preset}`),
        value: preset,
        icon: React.createElement(AccentSwatch, {
          color: getAccentSwatch(preset, variant, seed),
        }),
      }));
    },
    [t]
  );

  const lightAccentOptions = useMemo(
    () => buildAccentOptions("light", lightSkinId),
    [buildAccentOptions, lightSkinId]
  );
  const darkAccentOptions = useMemo(
    () => buildAccentOptions("dark", darkSkinId),
    [buildAccentOptions, darkSkinId]
  );

  /**
   * While linked, only skins shipping both variants can be chosen, and the
   * swatch previews the variant the user is currently looking at.
   */
  const unifiedSkinOptions = useMemo(
    () =>
      getUnifiedSkins().map((skin) => ({
        label: skin.label,
        value: skin.id,
        icon: React.createElement(SkinSwatch, {
          skinId: skin.id,
          variant: skinVariant,
        }),
      })),
    [skinVariant]
  );

  const unifiedSkinId = useMemo(
    () => (supportsBothVariants(lightSkinId) ? lightSkinId : darkSkinId),
    [lightSkinId, darkSkinId]
  );

  const unifiedAccentOptions = useMemo(
    () => buildAccentOptions(skinVariant, unifiedSkinId),
    [buildAccentOptions, skinVariant, unifiedSkinId]
  );

  const unifiedAccent = skinVariant === "dark" ? darkAccent : lightAccent;

  /** Quick-switch entry point for the sidebar menu: acts on the live variant. */
  const activeSkinOptions = useMemo(
    () => (skinVariant === "dark" ? darkSkinOptions : lightSkinOptions),
    [skinVariant, darkSkinOptions, lightSkinOptions]
  );

  const handleActiveSkinChange = useCallback(
    (skinId: string) => {
      if (skinVariant === "dark") setDarkSkinId(skinId);
      else setLightSkinId(skinId);
    },
    [skinVariant, setDarkSkinId, setLightSkinId]
  );

  const applicationUiFontOptions = useMemo(
    () =>
      APPLICATION_UI_FONT_IDS.map((fontId) => ({
        label: t(`general.applicationFontOptions.${fontId}`),
        value: fontId,
      })),
    [t]
  );

  const iconStyleOptions = useMemo(
    () =>
      (["colorful", "monochrome"] as const).map((style) => ({
        label: t(`general.iconStyleOptions.${style}`),
        value: style,
      })),
    [t]
  );

  return {
    uiScale,
    applicationUiFont,
    setApplicationUiFont,
    spotlightPlacement,
    setSpotlightPlacement,
    appearanceMode,
    appearanceModeOptions,
    applicationUiFontOptions,
    handleAppearanceModeChange,
    handleUIScaleChange,

    // Skins
    linkSkinVariants,
    setLinkSkinVariants,
    unifiedSkinId,
    unifiedSkinOptions,
    unifiedAccent,
    unifiedAccentOptions,
    activeSkinId,
    activeSkinOptions,
    handleActiveSkinChange,
    lightSkinId,
    setLightSkinId,
    darkSkinId,
    setDarkSkinId,
    lightSkinOptions,
    darkSkinOptions,

    // Accent
    lightAccent,
    setLightAccent: setLightAccent as (value: AccentPreset) => void,
    darkAccent,
    setDarkAccent: setDarkAccent as (value: AccentPreset) => void,
    lightAccentOptions,
    darkAccentOptions,

    // Surface + icons
    translucentSidebar,
    setTranslucentSidebar,
    iconStyle,
    setIconStyle,
    iconStyleOptions,
  };
}
