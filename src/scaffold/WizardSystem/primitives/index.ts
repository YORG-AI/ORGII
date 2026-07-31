/**
 * Shared Wizard Components
 *
 * Reusable building blocks for multi-step wizard flows.
 * Used by KeyVaultWizard, ChannelWizard, and future wizards.
 */

export const WIZARD_CONTENT_TOKENS = {
  /** Horizontal content inset (px-4) — matches DETAIL_PANEL_TOKENS.contentPadding */
  paddingClass: "px-4",
  /** Content bottom padding (pb-2) — reduced when footer follows */
  paddingBottomClass: "pb-2",
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

export { default as FormField, FORM_FIELD_TOKENS } from "./FormField";
export type { FormFieldProps } from "./FormField";

export { default as SelectionGrid } from "./SelectionGrid";
export type { SelectionGridProps, SelectionGridOption } from "./SelectionGrid";

export { default as WizardInfoCard } from "./WizardInfoCard";
export type { WizardInfoCardProps } from "./WizardInfoCard";

export { default as WizardProgressCard } from "./WizardProgressCard";
export type { WizardProgressCardProps } from "./WizardProgressCard";
