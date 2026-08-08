/**
 * WizardSystem
 *
 * Centralized wizard infrastructure for multi-step flows.
 * Parallel to ModalSystem and GlobalSpotlight in scaffold.
 *
 * - primitives/  — Layout building blocks (WizardShell, WizardStepLayout, FormField, etc.)
 * - shared/      — Cross-wizard shared components (KeyInputSection, ProviderSelector)
 * - variants/    — Domain-specific wizard implementations
 */

export {
  WIZARD_CONTENT_TOKENS,
  WizardShell,
  WizardStepContent,
  WIZARD_STEP_CONTENT_TOKENS,
  WizardStepNavigation,
  WIZARD_STEP_NAVIGATION_TOKENS,
  WizardStepLayout,
  FormField,
  FORM_FIELD_TOKENS,
  SelectionGrid,
  WizardInfoCard,
  WizardProgressCard,
} from "./primitives";

export type {
  WizardShellProps,
  WizardStepContentProps,
  WizardStepIcon,
  WizardStepIconProps,
  WizardStepNavigationItem,
  WizardStepNavigationProps,
  WizardStepLayoutProps,
  FormFieldProps,
  SelectionGridProps,
  SelectionGridOption,
  WizardInfoCardProps,
  WizardProgressCardProps,
} from "./primitives";
