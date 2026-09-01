/**
 * ActionCard Configuration
 *
 * Canonical selection card styles used across Code Accounts, Models, and Wizards.
 * All selectable cards should reference SELECTION_CARD_CLASSES for consistency.
 */
import type { ActionCardVariant } from "./types";

// ============================================
// Shared Selection Card Tokens
// ============================================

/**
 * Canonical classes for selection cards across the app.
 * Use these tokens anywhere a selectable card pattern is needed
 * (AgentSelection, ModelCard, credential pickers, etc.)
 */
export const SELECTION_CARD_CLASSES = {
  /** Base container (always applied) */
  base: "cursor-pointer rounded-lg border p-3 text-left transition-all",
  /** Selected state */
  selected: "border-primary-6 bg-primary-1",
  /** Unselected state — hover border matches Input (border-2 → border-3) */
  unselected: "border-border-2 bg-bg-2 hover:border-border-3 hover:bg-bg-2",
  /** Disabled state */
  disabled: "cursor-not-allowed opacity-50 bg-fill-2",
  /** Title text when selected */
  titleSelected: "text-primary-6",
  /** Title text when unselected */
  titleDefault: "text-text-1",
  /** Icon when selected */
  iconSelected: "text-primary-6",
  /** Icon when unselected */
  iconDefault: "text-text-2",
  /** Description text (all states) */
  description: "text-[12px] text-text-3",
  /** Check icon class when selected */
  checkIcon: "shrink-0 text-primary-6",
} as const;

/**
 * Helper to build container className for a selection card.
 */
export function getSelectionCardClass(
  isSelected: boolean,
  isDisabled = false
): string {
  if (isDisabled) {
    return `${SELECTION_CARD_CLASSES.base} ${SELECTION_CARD_CLASSES.disabled}`;
  }
  return `${SELECTION_CARD_CLASSES.base} ${
    isSelected
      ? SELECTION_CARD_CLASSES.selected
      : SELECTION_CARD_CLASSES.unselected
  }`;
}

// ============================================
// ActionCard Variant Styles
// ============================================

export interface VariantConfig {
  containerClass: string;
  containerHoverClass: string;
  titleClass: string;
  descriptionClass: string;
  iconClass: string;
  selectedContainerClass: string;
  selectedTitleClass: string;
  selectedIconClass: string;
}

export const VARIANT_STYLES: Record<ActionCardVariant, VariantConfig> = {
  primary: {
    containerClass: `${SELECTION_CARD_CLASSES.base} border-primary-3 bg-bg-2`,
    containerHoverClass: "",
    titleClass: "text-[13px] font-medium text-primary-6",
    descriptionClass: SELECTION_CARD_CLASSES.description,
    iconClass: "text-primary-6",
    selectedContainerClass: `${SELECTION_CARD_CLASSES.base} ${SELECTION_CARD_CLASSES.selected}`,
    selectedTitleClass: "text-[13px] font-medium text-primary-6",
    selectedIconClass: "text-primary-6",
  },
  default: {
    containerClass: `${SELECTION_CARD_CLASSES.base} ${SELECTION_CARD_CLASSES.unselected}`,
    containerHoverClass: "",
    titleClass: "text-[13px] font-medium text-text-1",
    descriptionClass: SELECTION_CARD_CLASSES.description,
    iconClass: "text-text-2",
    selectedContainerClass: `${SELECTION_CARD_CLASSES.base} ${SELECTION_CARD_CLASSES.selected}`,
    selectedTitleClass: "text-[13px] font-medium text-primary-6",
    selectedIconClass: "text-primary-6",
  },
  secondary: {
    containerClass: `${SELECTION_CARD_CLASSES.base} ${SELECTION_CARD_CLASSES.unselected}`,
    containerHoverClass: "",
    titleClass: "text-[13px] font-medium text-text-2",
    descriptionClass: SELECTION_CARD_CLASSES.description,
    iconClass: "text-text-2",
    selectedContainerClass: `${SELECTION_CARD_CLASSES.base} ${SELECTION_CARD_CLASSES.selected}`,
    selectedTitleClass: "text-[13px] font-medium text-primary-6",
    selectedIconClass: "text-primary-6",
  },
  subtle: {
    containerClass:
      "cursor-pointer rounded-lg border border-border-2 bg-bg-2 p-2 text-left transition-all hover:border-border-3 hover:bg-bg-2",
    containerHoverClass: "",
    titleClass: "text-[13px] font-medium text-text-1",
    descriptionClass: SELECTION_CARD_CLASSES.description,
    iconClass: "text-text-2",
    selectedContainerClass:
      "cursor-pointer rounded-lg border border-primary-6 bg-primary-1 p-2 text-left transition-all shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]",
    selectedTitleClass: "text-[13px] font-medium text-primary-6",
    selectedIconClass: "text-primary-6",
  },
};
