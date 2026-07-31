/**
 * SetupWalkthrough step configuration
 */
import {
  BookOpen,
  Bot,
  Building2,
  FolderGit2,
  ListChecks,
  Rocket,
  Settings2,
  ShieldCheck,
} from "lucide-react";

import {
  BasicsStep,
  GoalStep,
  OrganizationStep,
  ReadyStep,
  SharingStep,
  ToolsStep,
  TutorialStep,
  WorkModelStep,
} from "./steps/ReadinessSteps";
import type { StepConfig } from "./types";

// ============================================
// Step Configurations
// ============================================

export const STEP_CONFIGS: StepConfig[] = [
  {
    id: "goal",
    i18nKey: "goal",
    icon: ListChecks,
    component: GoalStep,
  },
  {
    id: "tools",
    i18nKey: "tools",
    icon: Bot,
    component: ToolsStep,
  },
  {
    id: "organization",
    i18nKey: "organization",
    icon: Building2,
    component: OrganizationStep,
  },
  {
    id: "sharing",
    i18nKey: "sharing",
    icon: ShieldCheck,
    component: SharingStep,
  },
  {
    id: "basics",
    i18nKey: "basics",
    icon: FolderGit2,
    component: BasicsStep,
  },
  {
    id: "tutorial",
    i18nKey: "tutorial",
    icon: BookOpen,
    component: TutorialStep,
  },
  {
    id: "work-model",
    i18nKey: "workModel",
    icon: Settings2,
    component: WorkModelStep,
  },
  {
    id: "ready",
    i18nKey: "ready",
    icon: Rocket,
    component: ReadyStep,
  },
];
