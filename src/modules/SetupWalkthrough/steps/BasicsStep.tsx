import { FolderGit2 } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Select from "@src/components/Select";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { WizardStepContent } from "@src/scaffold/WizardSystem/primitives";

import { BasicsStepIcon } from "../components/SetupStepIcons";
import type { StepProps } from "./types";

export const BasicsStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation(["onboarding", "settings"]);
  const {
    appearanceMode,
    appearanceModeOptions,
    globalThemeId,
    themeOptions,
    handleAppearanceModeChange,
    handleThemeChange,
  } = useAppearanceState();
  return (
    <WizardStepContent
      title={t("onboarding:readiness.basics.title")}
      description={t("onboarding:readiness.basics.description")}
      icon={BasicsStepIcon}
    >
      <SectionContainer>
        <SectionRow label={t("settings:general.appearanceMode")}>
          <Select
            value={appearanceMode}
            onChange={handleAppearanceModeChange}
            options={appearanceModeOptions}
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow label={t("settings:general.themePreset")}>
          <Select
            value={globalThemeId}
            onChange={(value) => handleThemeChange(String(value))}
            options={themeOptions}
            showSearch
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow
          label={t("onboarding:readiness.basics.workspace")}
          description={t("onboarding:readiness.basics.workspaceDescription")}
        >
          <Button
            size="small"
            icon={<FolderGit2 size={14} />}
            onClick={() => openWorkspaceSpotlight("open")}
          >
            {controller.workspaceFolders.length
              ? t("onboarding:readiness.basics.changeWorkspace")
              : t("onboarding:readiness.basics.openWorkspace")}
          </Button>
        </SectionRow>
      </SectionContainer>
      <InlineAlert type="info">
        {t("onboarding:readiness.basics.settingsHint")}
      </InlineAlert>
    </WizardStepContent>
  );
};
