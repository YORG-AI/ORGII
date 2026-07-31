/**
 * Shared Wizard Components
 *
 * Reusable building blocks for multi-step wizard flows.
 * Used by KeyVaultWizard, ChannelWizard, and future wizards.
 */
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

export const WIZARD_CONTENT_TOKENS = {
  /** Horizontal content inset (px-4) — matches DETAIL_PANEL_TOKENS.contentPadding */
  paddingClass: DETAIL_PANEL_TOKENS.contentPadding,
  /** Content bottom padding (pb-2) — reduced when footer follows */
  paddingBottomClass: DETAIL_PANEL_TOKENS.contentPaddingBottom,
} as const;

export { default as WizardShell } from "./WizardShell";
export type { WizardShellProps } from "./WizardShell";

export { default as WizardStepLayout } from "./WizardStepLayout";
export type { WizardStepLayoutProps } from "./WizardStepLayout";

export {
  default as WizardStepContent,
  WIZARD_STEP_CONTENT_TOKENS,
} from "./WizardStepContent";
export type { WizardStepContentProps } from "./WizardStepContent";

export {
  default as WizardStepNavigation,
  WIZARD_STEP_NAVIGATION_TOKENS,
} from "./WizardStepNavigation";
export type {
  WizardStepIcon,
  WizardStepIconProps,
  WizardStepNavigationItem,
  WizardStepNavigationProps,
} from "./WizardStepNavigation";

export { default as FormField, FORM_FIELD_TOKENS } from "./FormField";
export type { FormFieldProps } from "./FormField";

export { default as SelectionGrid } from "./SelectionGrid";
export type { SelectionGridProps, SelectionGridOption } from "./SelectionGrid";

export { default as WizardInfoCard } from "./WizardInfoCard";
export type { WizardInfoCardProps } from "./WizardInfoCard";

export { default as WizardProgressCard } from "./WizardProgressCard";
export type { WizardProgressCardProps } from "./WizardProgressCard";
