import { BriefcaseBusiness, User, Users } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import InlineAlert from "@src/components/InlineAlert";
import {
  SelectionGrid,
  type SelectionGridOption,
  WizardStepContent,
} from "@src/scaffold/WizardSystem/primitives";

import { GoalStepIcon } from "../components/SetupStepIcons";
import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";
import type { StepProps } from "./types";

export const GoalStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const options = useMemo<
    SelectionGridOption<NonNullable<typeof controller.progress.goal>>[]
  >(
    () => [
      {
        key: "personal",
        label: t("readiness.goal.personal.title"),
        description: t("readiness.goal.personal.description"),
        icon: User,
        dataTestId: "setup-goal-personal",
      },
      {
        key: "team_activity",
        label: t("readiness.goal.team.title"),
        description: t("readiness.goal.team.description"),
        icon: Users,
        dataTestId: "setup-goal-team",
      },
      {
        key: "work_management",
        label: t("readiness.goal.work.title"),
        description: t("readiness.goal.work.description"),
        icon: BriefcaseBusiness,
        dataTestId: "setup-goal-work",
      },
    ],
    [t]
  );
  return (
    <WizardStepContent
      title={t("readiness.goal.title")}
      description={t("readiness.goal.description")}
      icon={GoalStepIcon}
    >
      <SelectionGrid
        options={options}
        selected={controller.progress.goal}
        onSelect={controller.selectGoal}
        columns={1}
        cardLayout="inline"
        showSelectionCheck={false}
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid}
      />
      <InlineAlert type="info">{t("readiness.goal.hint")}</InlineAlert>
    </WizardStepContent>
  );
};
