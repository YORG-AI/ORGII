import React, { type ComponentType, type FC, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import LanguageSelector from "@src/components/LanguageSelector";
import Select, { type SelectOption } from "@src/components/Select";
import type { PrimaryColorPreset } from "@src/config/appearance/primaryColors";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";
import {
  FormField,
  WizardStepContent,
} from "@src/scaffold/WizardSystem/primitives";

import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";
import {
  AppearancePreferenceIcon,
  BasicsStepIcon,
  LanguagePreferenceIcon,
  ThemePreferenceIcon,
} from "./SetupStepIcons";

export type SetupPreferencesPresentation = "native" | "cinematic";

interface SetupPreferencesPanelProps {
  isClosing: boolean;
  onComplete: () => void;
  onSkip: () => void;
  initialPresentation?: SetupPreferencesPresentation;
}

interface PreferenceLabelProps {
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  showAccent?: boolean;
}

const CinematicPreferenceLabel: FC<PreferenceLabelProps> = ({
  icon: Icon,
  label,
  showAccent = false,
}) => (
  <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceLabel}>
    <span className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceIcon}>
      {showAccent ? (
        <span className="block size-4 rounded-full bg-primary-6" aria-hidden />
      ) : (
        Icon && <Icon size={HEADER_ICON_SIZE.md} aria-hidden="true" />
      )}
    </span>
    <span>{label}</span>
  </span>
);

/**
 * Both presentations bind to the same canonical settings state. The selector
 * is intentionally component-local preview state: changing the visual version
 * never writes an application preference or changes onboarding completion.
 */
const SetupPreferencesPanel: React.FC<SetupPreferencesPanelProps> = ({
  isClosing,
  onComplete,
  onSkip,
  initialPresentation = "native",
}) => {
  const { t } = useTranslation(["onboarding", "settings"]);
  const [presentation, setPresentation] =
    useState<SetupPreferencesPresentation>(initialPresentation);
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
  const isCinematic = presentation === "cinematic";

  const presentationOptions: SelectOption[] = [
    {
      value: "native",
      label: t("onboarding:readiness.presentation.native"),
    },
    {
      value: "cinematic",
      label: t("onboarding:readiness.presentation.cinematic"),
    },
  ];

  const preferenceFields = (
    <SectionContainer
      dataTestId="setup-preferences"
      className={
        isCinematic
          ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceList
          : undefined
      }
    >
      <SectionRow
        label={
          isCinematic ? (
            <CinematicPreferenceLabel
              icon={LanguagePreferenceIcon}
              label={languageLabel}
            />
          ) : (
            languageLabel
          )
        }
        className={
          isCinematic
            ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceRow
            : undefined
        }
      >
        {isCinematic ? (
          <div
            className={
              SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceControl
            }
          >
            <LanguageSelector
              className="w-full"
              showIcon={false}
              size="large"
              variant="ghost"
              ariaLabel={languageLabel}
            />
          </div>
        ) : (
          <LanguageSelector
            className="w-full"
            showIcon={false}
            size="large"
            ariaLabel={languageLabel}
          />
        )}
      </SectionRow>
      <SectionRow
        label={
          isCinematic ? (
            <CinematicPreferenceLabel
              icon={AppearancePreferenceIcon}
              label={appearanceLabel}
            />
          ) : (
            appearanceLabel
          )
        }
        className={
          isCinematic
            ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceRow
            : undefined
        }
      >
        <Select
          value={appearanceMode}
          onChange={handleAppearanceModeChange}
          options={appearanceModeOptions}
          style={SECTION_CONTROL_STYLE}
          className={
            isCinematic
              ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceControl
              : undefined
          }
          size="large"
          variant={isCinematic ? "ghost" : "default"}
          ariaLabel={appearanceLabel}
          dataTestId="setup-appearance-mode"
        />
      </SectionRow>
      <SectionRow
        label={
          isCinematic ? (
            <CinematicPreferenceLabel
              icon={ThemePreferenceIcon}
              label={themeLabel}
            />
          ) : (
            themeLabel
          )
        }
        className={
          isCinematic
            ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceRow
            : undefined
        }
      >
        <Select
          value={globalThemeId}
          onChange={(value) => void handleThemeChange(String(value))}
          options={themeOptions}
          style={SECTION_CONTROL_STYLE}
          className={
            isCinematic
              ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceControl
              : undefined
          }
          size="large"
          variant={isCinematic ? "ghost" : "default"}
          ariaLabel={themeLabel}
          dataTestId="setup-theme"
        />
      </SectionRow>
      <SectionRow
        label={
          isCinematic ? (
            <CinematicPreferenceLabel label={colorLabel} showAccent />
          ) : (
            colorLabel
          )
        }
        className={
          isCinematic
            ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceRow
            : undefined
        }
      >
        <Select
          value={primaryColorPreset}
          onChange={(value) =>
            setPrimaryColorPreset(String(value) as PrimaryColorPreset)
          }
          options={primaryColorOptions}
          style={SECTION_CONTROL_STYLE}
          className={
            isCinematic
              ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceControl
              : undefined
          }
          size="large"
          variant={isCinematic ? "ghost" : "default"}
          ariaLabel={colorLabel}
          dataTestId="setup-primary-color"
        />
      </SectionRow>
    </SectionContainer>
  );

  const terminalActions = isCinematic ? (
    <>
      <Button
        variant="primary"
        size="large"
        long
        loading={isClosing}
        disabled={isClosing}
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceCta}
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
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceSecondary}
        data-testid="setup-skip"
        onClick={onSkip}
      >
        {t("onboarding:navigation.skipSetup")}
      </Button>
    </>
  ) : (
    <div className={DETAIL_PANEL_TOKENS.contentStack}>
      <Button
        variant="primary"
        size="large"
        long
        loading={isClosing}
        disabled={isClosing}
        data-testid="setup-finish"
        onClick={onComplete}
      >
        {t("onboarding:navigation.getStarted")} <span aria-hidden>→</span>
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
  );

  const form = (
    <WizardStepContent
      title={t("onboarding:readiness.basics.title")}
      description={t("onboarding:readiness.basics.description")}
      icon={BasicsStepIcon}
      className={
        isCinematic
          ? SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceContent
          : undefined
      }
    >
      {preferenceFields}
      {terminalActions}
    </WizardStepContent>
  );

  return (
    <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.presentationStack}>
      <div className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.presentationToolbar}>
        <FormField
          label={t("onboarding:readiness.presentation.label")}
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.presentationField}
        >
          <Select
            value={presentation}
            options={presentationOptions}
            onChange={(value) =>
              setPresentation(value === "cinematic" ? "cinematic" : "native")
            }
            style={SECTION_CONTROL_STYLE}
            disabled={isClosing}
            ariaLabel={t("onboarding:readiness.presentation.label")}
            dataTestId="setup-presentation"
          />
        </FormField>
      </div>

      {isCinematic ? (
        <div
          className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceCard}
          data-testid="setup-presentation-cinematic"
        >
          {form}
        </div>
      ) : (
        <div
          className={DETAIL_PANEL_TOKENS.contentWidth}
          data-testid="setup-presentation-native"
        >
          {form}
        </div>
      )}
    </div>
  );
};

export default SetupPreferencesPanel;
