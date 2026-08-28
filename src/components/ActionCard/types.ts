/**
 * ActionCard Types
 */
import type { ReactNode } from "react";

import type { IconSvgElement } from "@src/icons";

export type ActionCardVariant = "default" | "primary" | "secondary" | "subtle";
export type ActionCardLayout = "inline" | "stacked";

export interface ActionCardProps {
  /**
   * Card title
   */
  title: string;

  /**
   * Card description
   */
  description?: string;

  /**
   * Click handler
   */
  onClick: () => void;

  /**
   * Visual variant
   * @default 'default'
   */
  variant?: ActionCardVariant;

  /**
   * Content arrangement. Stacked keeps badges and selection affordances out of
   * the title row for wider choice cards.
   * @default 'inline'
   */
  layout?: ActionCardLayout;

  /**
   * Icon data (hugeicons glyph).
   * For custom icons (e.g. ModelIcon), use iconElement instead.
   */
  icon?: IconSvgElement;

  /**
   * Custom icon element (ReactNode). Takes precedence over `icon`.
   * Use for component icons like ModelIcon.
   */
  iconElement?: ReactNode;

  /**
   * When true, icon keeps its color in selected state (e.g. brand icons like GitHub).
   * @default false
   */
  iconPreserveColor?: boolean;

  /**
   * Button text (if provided, shows button on the right)
   */
  buttonText?: string;

  /**
   * Button loading state
   * @default false
   */
  buttonLoading?: boolean;

  /**
   * Disabled state
   * @default false
   */
  disabled?: boolean;

  /**
   * Show selection indicator (checkmark style)
   * @default false
   */
  showSelect?: boolean;

  /**
   * When showSelect is true, render the trailing checkmark for the selected state.
   * Set false to keep selected border styling without the check icon.
   * @default true
   */
  showSelectionCheck?: boolean;

  /**
   * Show checkbox indicator on the left side of the card.
   * Takes precedence over showSelect when both are true.
   * @default false
   */
  showCheckbox?: boolean;

  /**
   * Show radio indicator on the left side of the card.
   * Use for single-select groups. Takes precedence over showSelect.
   * @default false
   */
  showRadio?: boolean;

  /**
   * Selected state (used when showSelect, showCheckbox, or showRadio is true)
   * @default false
   */
  selected?: boolean;

  /**
   * Show arrow-right on hover/active state.
   * Useful for shortcut/navigation cards.
   * @default false
   */
  showArrow?: boolean;

  /**
   * Tooltip shown via info icon inside the card.
   * When provided, renders a small info icon that shows this text on hover.
   * Use for compact single-line cards where description would add a second line.
   */
  tooltip?: string;

  /**
   * Badge text shown next to the title (e.g. "Recommended").
   * Rendered as a small pill.
   */
  badge?: string;

  /**
   * Stable test id for rendered E2E flows.
   */
  dataTestId?: string;

  /**
   * Render an inline card as a compact 36px segmented control.
   */
  compact?: boolean;

  /**
   * Additional CSS classes
   */
  className?: string;
}
