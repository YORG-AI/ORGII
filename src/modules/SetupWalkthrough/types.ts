/**
 * Types for SetupWalkthrough module
 */
import type { ComponentType } from "react";

import type { WizardStepIcon } from "@src/scaffold/WizardSystem";

import type { SetupWalkthroughController } from "./useSetupWalkthroughController";

// ============================================
// Step Configuration Types
// ============================================

/** Step config with translation keys instead of static strings */
export interface StepConfig {
  id: import("./flow").SetupStepId;
  /** Translation key under steps.{key}.title */
  i18nKey: string;
  icon: WizardStepIcon;
  component: ComponentType<{ controller: SetupWalkthroughController }>;
}
