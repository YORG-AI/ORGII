import { ArrowRight } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import LanguageSelector from "@src/components/LanguageSelector";
import Select from "@src/components/Select";
import type { PrimaryColorPreset } from "@src/config/appearance/primaryColors";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";
import { WizardStepContent } from "@src/scaffold/WizardSystem/primitives";

import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";
import { BasicsStepIcon } from "./SetupStepIcons";

interface SetupPreferencesPanelProps {
  isClosing: boolean;
  onComplete: () => void;
  onSkip: () => void;
}

/**
 * Linear-style first-run preferences. Every control writes through the same
 * canonical Settings hooks as the full settings page; advanced theme-preset
 * selection stays in Settings rather than becoming a first-launch decision.
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
    handleAppearanceModeChange,
    primaryColorOptions,
    primaryColorPreset,
    setPrimaryColorPreset,
  } = useAppearanceState();

  const languageLabel = t("settings:general.language");
  const appearanceLabel = t("settings:general.appearanceMode");
  const colorLabel = t("settings:general.primaryColor");
  return (
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
          label={languageLabel}
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceRow}
        >
          <LanguageSelector
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceControl}
            showIcon={false}
            size="large"
            appearance="ghost"
            ariaLabel={languageLabel}
          />
        </SectionRow>
        <SectionRow
          label={appearanceLabel}
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceRow}
        >
          <Select
            value={appearanceMode}
            onChange={handleAppearanceModeChange}
            options={appearanceModeOptions}
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceControl}
            size="large"
            appearance="ghost"
            ariaLabel={appearanceLabel}
            dataTestId="setup-appearance-mode"
          />
        </SectionRow>
        <SectionRow
          label={colorLabel}
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceRow}
        >
          <Select
            value={primaryColorPreset}
            onChange={(value) =>
              setPrimaryColorPreset(String(value) as PrimaryColorPreset)
            }
            options={primaryColorOptions}
            className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.preferenceControl}
            size="large"
            appearance="ghost"
            ariaLabel={colorLabel}
            dataTestId="setup-primary-color"
          />
        </SectionRow>
      </SectionContainer>

      <div className={DETAIL_PANEL_TOKENS.contentStack}>
        <Button
          variant="primary"
          size="large"
          long
          loading={isClosing}
          disabled={isClosing}
          icon={<ArrowRight aria-hidden size={16} />}
          iconPosition="right"
          data-testid="setup-finish"
          onClick={onComplete}
        >
          {t("onboarding:navigation.getStarted")}
        </Button>
        <Button
          variant="tertiary"
          appearance="ghost"
          disabled={isClosing}
          data-testid="setup-skip"
          onClick={onSkip}
        >
          {t("onboarding:navigation.skipSetup")}
        </Button>
      </div>
    </WizardStepContent>
  );
};

export default SetupPreferencesPanel;
