/**
 * SetupWalkthrough step configuration
 */
import {
  BasicsStepIcon,
  GoalStepIcon,
  OrganizationStepIcon,
  ReadyStepIcon,
  SharingStepIcon,
  ToolsStepIcon,
  TutorialStepIcon,
  WorkModelStepIcon,
} from "./components/SetupStepIcons";
import {
  BasicsStep,
  GoalStep,
  OrganizationStep,
  ReadyStep,
  SharingStep,
  ToolsStep,
  TutorialStep,
  WorkModelStep,
} from "./steps";
import type { StepConfig } from "./types";

// ============================================
// Step Configurations
// ============================================

export const STEP_CONFIGS: StepConfig[] = [
  {
    id: "goal",
    i18nKey: "goal",
    icon: GoalStepIcon,
    component: GoalStep,
  },
  {
    id: "tools",
    i18nKey: "tools",
    icon: ToolsStepIcon,
    component: ToolsStep,
  },
  {
    id: "organization",
    i18nKey: "organization",
    icon: OrganizationStepIcon,
    component: OrganizationStep,
  },
  {
    id: "sharing",
    i18nKey: "sharing",
    icon: SharingStepIcon,
    component: SharingStep,
  },
  {
    id: "basics",
    i18nKey: "basics",
    icon: BasicsStepIcon,
    component: BasicsStep,
  },
  {
    id: "tutorial",
    i18nKey: "tutorial",
    icon: TutorialStepIcon,
    component: TutorialStep,
  },
  {
    id: "work-model",
    i18nKey: "workModel",
    icon: WorkModelStepIcon,
    component: WorkModelStep,
  },
  {
    id: "ready",
    i18nKey: "ready",
    icon: ReadyStepIcon,
    component: ReadyStep,
  },
];
