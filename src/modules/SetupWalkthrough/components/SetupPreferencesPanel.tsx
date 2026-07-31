import React from "react";
import { useTranslation } from "react-i18next";

import LanguageSelector from "@src/components/LanguageSelector";
import Select from "@src/components/Select";
import type { PrimaryColorPreset } from "@src/config/appearance/primaryColors";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionDescription,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { WizardStepContent } from "@src/scaffold/WizardSystem/primitives";

import { BasicsStepIcon } from "./SetupStepIcons";

/**
 * The first-run surface intentionally owns no preference state. Each control
 * is the same settings control/state boundary used by the main application,
 * so changes preview immediately and survive a reload without a second sync.
 */
const SetupPreferencesPanel: React.FC = () => {
  const { t } = useTranslation(["onboarding", "settings"]);
  const {
    appearanceMode,
    appearanceModeOptions,
    globalThemeId,
    handleAppearanceModeChange,
    handleThemeChange,
    primaryColorOptions,
    primaryColorPreset,
    setPrimaryColorPreset,
    themeOptions,
  } = useAppearanceState();

  return (
    <WizardStepContent
      title={t("onboarding:readiness.basics.title")}
      description={t("onboarding:readiness.basics.description")}
      icon={BasicsStepIcon}
    >
      <SectionContainer dataTestId="setup-preferences">
        <SectionRow label={t("settings:general.language")}>
          <div style={SECTION_CONTROL_STYLE}>
            <LanguageSelector className="w-full" showIcon={false} />
          </div>
        </SectionRow>
        <SectionRow label={t("settings:general.appearanceMode")}>
          <Select
            value={appearanceMode}
            onChange={handleAppearanceModeChange}
            options={appearanceModeOptions}
            style={SECTION_CONTROL_STYLE}
            dataTestId="setup-appearance-mode"
          />
        </SectionRow>
        <SectionRow label={t("settings:general.themePreset")}>
          <Select
            value={globalThemeId}
            onChange={(value) => void handleThemeChange(String(value))}
            options={themeOptions}
            style={SECTION_CONTROL_STYLE}
            dataTestId="setup-theme"
          />
        </SectionRow>
        <SectionRow label={t("settings:general.primaryColor")}>
          <Select
            value={primaryColorPreset}
            onChange={(value) =>
              setPrimaryColorPreset(String(value) as PrimaryColorPreset)
            }
            options={primaryColorOptions}
            style={SECTION_CONTROL_STYLE}
            dataTestId="setup-primary-color"
          />
        </SectionRow>
      </SectionContainer>
      <SectionDescription>
        {t("onboarding:readiness.basics.settingsHint")}
      </SectionDescription>
    </WizardStepContent>
  );
};

export default SetupPreferencesPanel;
