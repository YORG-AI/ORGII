/**
 * Theme Selection Step
 *
 * Allows user to select background/theme settings.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import { BackgroundSettings } from "@src/modules/MainApp/Settings/subpages/BackgroundPage";
import {
  SECTION_CONTROL_STYLE,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { AnimatedTitle } from "../components";

const IS_MACOS_HOST = resolveHostDesktop() === HOST_DESKTOP.MACOS;

const MacOSThemeControls: React.FC = () => {
  const { t } = useTranslation("settings");
  const {
    appearanceMode,
    appearanceModeOptions,
    globalThemeId,
    themeOptions,
    handleAppearanceModeChange,
    handleThemeChange,
  } = useAppearanceState();

  return (
    <div className="flex flex-col gap-2 px-6">
      <SectionRow compact label={t("general.appearanceMode")}>
        <Select
          value={appearanceMode}
          onChange={handleAppearanceModeChange}
          options={appearanceModeOptions}
          size="default"
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow compact label={t("general.themePreset")}>
        <Select
          value={globalThemeId}
          onChange={(value) => handleThemeChange(String(value))}
          options={themeOptions}
          showSearch
          size="default"
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
    </div>
  );
};

export const ThemeSelectionStep: React.FC = () => {
  const { t } = useTranslation("onboarding");

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden scrollbar-hide">
      <AnimatedTitle
        title={t("theme.title")}
        subtitle={t("theme.description")}
      />
      <div className="absolute inset-0 top-14 flex animate-[fadeInUp_0.6s_ease-out_2s_backwards] flex-col scrollbar-hide">
        {IS_MACOS_HOST ? (
          <MacOSThemeControls />
        ) : (
          <BackgroundSettings
            showHeader={false}
            translationNamespace="settings"
          />
        )}
      </div>
    </div>
  );
};
