import React, { type ComponentType, type FC } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import LanguageSelector from "@src/components/LanguageSelector";
import Select from "@src/components/Select";
import type { PrimaryColorPreset } from "@src/config/appearance/primaryColors";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { WizardStepContent } from "@src/scaffold/WizardSystem/primitives";

import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";
import {
  AppearancePreferenceIcon,
  BasicsStepIcon,
  LanguagePreferenceIcon,
  ThemePreferenceIcon,
} from "./SetupStepIcons";

interface SetupPreferencesPanelProps {
  isClosing: boolean;
  onComplete: () => void;
  onSkip: () => void;
}

interface PreferenceLabelProps {
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  showAccent?: boolean;
}

const PreferenceLabel: FC<PreferenceLabelProps> = ({
  icon: Icon,
  label,
  showAccent = false,
}) => (
  <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceLabel}>
    <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceIcon}>
      {showAccent ? (
        <span className="h-4 w-4 rounded-full bg-primary-6" aria-hidden />
      ) : (
        Icon && <Icon size={18} aria-hidden="true" />
      )}
    </span>
    <span>{label}</span>
  </span>
);

/**
 * The first-run surface intentionally owns no preference state. Each control
 * uses the same settings state boundary as the main application, so preview,
 * persistence, and later edits stay in sync without a setup-only draft.
 */
const SetupPreferencesPanel: React.FC<SetupPreferencesPanelProps> = ({
  isClosing,
  onComplete,
  onSkip,
}) => {
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

  const languageLabel = t("settings:general.language");
  const appearanceLabel = t("settings:general.appearanceMode");
  const themeLabel = t("settings:general.themePreset");
  const colorLabel = t("settings:general.primaryColor");

  return (
    <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceCard}>
      <WizardStepContent
        title={t("onboarding:readiness.basics.title")}
        description={t("onboarding:readiness.basics.description")}
        icon={BasicsStepIcon}
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceContent}
      >
        <SectionContainer
          dataTestId="setup-preferences"
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceList}
        >
          <SectionRow
            label={
              <PreferenceLabel
                icon={LanguagePreferenceIcon}
                label={languageLabel}
              />
            }
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceRow}
          >
            <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceControl}>
              <LanguageSelector
                className="w-full"
                showIcon={false}
                size="large"
                variant="ghost"
                ariaLabel={languageLabel}
              />
            </div>
          </SectionRow>
          <SectionRow
            label={
              <PreferenceLabel
                icon={AppearancePreferenceIcon}
                label={appearanceLabel}
              />
            }
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceRow}
          >
            <Select
              value={appearanceMode}
              onChange={handleAppearanceModeChange}
              options={appearanceModeOptions}
              style={SECTION_CONTROL_STYLE}
              className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceControl}
              size="large"
              variant="ghost"
              ariaLabel={appearanceLabel}
              dataTestId="setup-appearance-mode"
            />
          </SectionRow>
          <SectionRow
            label={
              <PreferenceLabel icon={ThemePreferenceIcon} label={themeLabel} />
            }
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceRow}
          >
            <Select
              value={globalThemeId}
              onChange={(value) => void handleThemeChange(String(value))}
              options={themeOptions}
              style={SECTION_CONTROL_STYLE}
              className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceControl}
              size="large"
              variant="ghost"
              ariaLabel={themeLabel}
              dataTestId="setup-theme"
            />
          </SectionRow>
          <SectionRow
            label={<PreferenceLabel label={colorLabel} showAccent />}
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceRow}
          >
            <Select
              value={primaryColorPreset}
              onChange={(value) =>
                setPrimaryColorPreset(String(value) as PrimaryColorPreset)
              }
              options={primaryColorOptions}
              style={SECTION_CONTROL_STYLE}
              className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceControl}
              size="large"
              variant="ghost"
              ariaLabel={colorLabel}
              dataTestId="setup-primary-color"
            />
          </SectionRow>
        </SectionContainer>

        <Button
          variant="primary"
          size="large"
          long
          loading={isClosing}
          disabled={isClosing}
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceCta}
          data-testid="setup-finish"
          onClick={onComplete}
        >
          {t("onboarding:navigation.getStarted")} <span aria-hidden>→</span>
        </Button>
        <Button
          variant="tertiary"
          appearance="ghost"
          size="small"
          disabled={isClosing}
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceSecondary}
          data-testid="setup-skip"
          onClick={onSkip}
        >
          {t("onboarding:navigation.skipSetup")}
        </Button>
      </WizardStepContent>
    </div>
  );
};

export default SetupPreferencesPanel;
