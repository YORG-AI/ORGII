import { LayoutDashboard, MonitorCog } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import InlineAlert from "@src/components/InlineAlert";
import { TUTORIALS } from "@src/scaffold/Tutorials/tutorialRegistry";
import {
  SelectionGrid,
  WizardStepContent,
} from "@src/scaffold/WizardSystem/primitives";

import { TutorialStepIcon } from "../components/SetupStepIcons";
import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";
import type { StepProps } from "./types";

export const TutorialStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const options = TUTORIALS.map((tutorial) => ({
    key: tutorial.id,
    label: t(tutorial.titleKey),
    description: `${t(tutorial.descriptionKey)} · ${t(tutorial.durationKey)}`,
    icon: tutorial.id === "general-layout" ? LayoutDashboard : MonitorCog,
  }));
  return (
    <WizardStepContent
      title={t("readiness.tutorial.title")}
      description={t("readiness.tutorial.description")}
      icon={TutorialStepIcon}
    >
      <SelectionGrid
        options={options}
        selected={controller.progress.tutorialId}
        onSelect={(tutorialId) => controller.patchProgress({ tutorialId })}
        columns={2}
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid}
      />
      <InlineAlert type="info">{t("readiness.tutorial.hint")}</InlineAlert>
    </WizardStepContent>
  );
};
