/**
 * SelectorPill
 *
 * Shared pill trigger button used by ModePill, RunningLocationPill, and the
 * Launchpad agent selector. The session creator's model/source row and
 * repo/branch row use `PillGroup` instead, which renders an invisible row of
 * segments separated by `|` until a segment is hovered or active.
 *
 * Pattern: icon + label; on hover (or when active) the icon swaps to
 * a chevron or caller-provided hover icon to signal interactivity.
 *
 * Size tokens for sm/md are sourced from CompoundPill/config to stay in sync
 * with the CompoundPill segment dimensions.
 */
import { ChevronDown, ChevronUp } from "lucide-react";
import React, { forwardRef, useCallback, useState } from "react";

import {
  PILL_CONTROL_ACTIVE_SURFACE_CLASS,
  PILL_CONTROL_HOVER_CLASS,
  PILL_SM_HEIGHT_CLASS,
  PILL_SM_ICON_CONTAINER_CLASS,
  PILL_SM_ICON_SIZE,
  PILL_SM_LABEL_CLASS,
} from "@src/components/CompoundPill/config";
import Tooltip, { type TooltipPosition } from "@src/components/Tooltip";
import type { BareControlAppearance } from "@src/components/controlAppearance";

// ── Size variants ────────────────────────────────────────────────────────────
// "sm" — h-[28px] px-3 text-[12px]  14px icon  (toolbar pills: ModePill, RunningLocationPill)
// "md" — h-[32px] px-3 text-[14px]  14px icon  (standalone selector pill: Launchpad agent selector)
// "lg" — inline hero selector        20px icon  (ChatPanel inline header)
// "xl" — large hero button           28px icon  (ChatPanel session creator)

const SIZE_CLASSES = {
  sm: `${PILL_SM_HEIGHT_CLASS} px-3 text-[12px]`,
  md: "h-[32px] px-3 text-[14px]",
  lg: "min-h-[42px] px-1.5 text-[24px] font-medium tracking-wide leading-[1.2] overflow-visible",
  xl: "px-4 py-2 text-[28px] font-bold tracking-wide overflow-visible",
} as const;

const GAP_CLASSES = {
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-2",
  xl: "gap-2",
} as const;

const ICON_CONTAINER_CLASSES = {
  sm: PILL_SM_ICON_CONTAINER_CLASS,
  md: PILL_SM_ICON_CONTAINER_CLASS,
  lg: "relative inline-flex h-[20px] w-[20px] items-center justify-center",
  xl: "relative inline-flex h-[28px] w-[28px] items-center justify-center",
} as const;

const ICON_SIZES = {
  sm: PILL_SM_ICON_SIZE,
  md: PILL_SM_ICON_SIZE,
  lg: 20,
  xl: 28,
} as const;

export type SelectorPillSize = keyof typeof SIZE_CLASSES;

interface SelectorPillContentProps {
  icon: React.ReactNode;
  label: string;
  labelContent?: React.ReactNode;
  size: SelectorPillSize;
  active: boolean;
  trailingChevron: boolean;
  textOnly: boolean;
  hoverIcon?: React.ReactNode;
  iconColor: string;
  chevronColor: string;
  chevronClassName?: string;
  labelColor: string;
  labelClassName?: string;
  iconSize: number;
  labelStyle?: React.CSSProperties;
}

const SelectorPillContent: React.FC<SelectorPillContentProps> = ({
  icon,
  label,
  labelContent,
  size,
  active,
  trailingChevron,
  textOnly,
  hoverIcon,
  iconColor,
  chevronColor,
  chevronClassName,
  labelColor,
  labelClassName,
  iconSize,
  labelStyle,
}) => {
  return (
    <span
      className={`inline-flex h-full min-w-0 items-center ${label && !textOnly ? GAP_CLASSES[size] : ""}`}
    >
      {!textOnly && (
        <span
          className={`relative inline-flex shrink-0 items-center justify-center ${ICON_CONTAINER_CLASSES[size]}`}
        >
          {trailingChevron ? (
            <span
              className={`inline-flex items-center justify-center ${iconColor}`}
            >
              {icon}
            </span>
          ) : (
            <>
              {icon !== null && (
                <span
                  className={`${active ? "hidden" : "group-hover/pill:hidden"} inline-flex items-center justify-center ${iconColor}`}
                >
                  {icon}
                </span>
              )}
              {active ? (
                <ChevronUp
                  size={iconSize}
                  strokeWidth={1.75}
                  className={`absolute block ${chevronColor}`}
                />
              ) : hoverIcon ? (
                <span
                  className={`absolute hidden items-center justify-center ${chevronColor} group-hover/pill:flex`}
                >
                  {hoverIcon}
                </span>
              ) : (
                <ChevronDown
                  size={iconSize}
                  strokeWidth={1.75}
                  className={`absolute hidden ${chevronColor} group-hover/pill:block`}
                />
              )}
            </>
          )}
        </span>
      )}

      {label && (
        <span
          className={`min-w-0 ${PILL_SM_LABEL_CLASS} ${
            labelClassName ?? labelColor
          } ${
            labelContent || size === "xl"
              ? "inline-flex items-center"
              : "inline-block truncate"
          }`}
          style={labelStyle}
        >
          {labelContent ?? label}
        </span>
      )}

      {trailingChevron && !textOnly && (
        <span
          className={`inline-flex shrink-0 items-center justify-center ${chevronColor} ${chevronClassName ?? ""}`}
        >
          {active ? (
            <ChevronUp size={14} strokeWidth={2} />
          ) : (
            <ChevronDown size={14} strokeWidth={2} />
          )}
        </span>
      )}
    </span>
  );
};

export interface SelectorPillProps {
  /** Icon shown at rest (before hover). Pass null to show nothing at rest. */
  icon: React.ReactNode;
  /** Label text */
  label: string;
  /** Custom label body. Keep label set for sizing, title, and accessibility. */
  labelContent?: React.ReactNode;
  /** Native title attribute (fallback tooltip) */
  title?: string;
  /** Styled tooltip content shown via the Tooltip component on hover */
  tooltip?: React.ReactNode;
  /** Framed-panel tooltip style (matches chat header / PillGroup segments) */
  tooltipFramed?: boolean;
  /** Widen framed-panel tooltips for long breadcrumb content. */
  tooltipFramedWide?: boolean;
  /** Tooltip position — defaults to "top" */
  tooltipPosition?: TooltipPosition;
  /** Delay before showing the tooltip. Defaults to 400 ms. */
  tooltipMouseEnterDelay?: number;
  /** Whether the pill is in an open/active state */
  active?: boolean;
  /** Color treatment for the open/active state. */
  activeTone?: "primary" | "neutral";
  /** Render label in danger color to signal a missing required selection */
  danger?: boolean;
  /** Size variant */
  size?: SelectorPillSize;
  /** Visual appearance */
  appearance?: BareControlAppearance;
  /** Show a persistent right-side chevron instead of swapping the leading icon on hover */
  trailingChevron?: boolean;
  /** Label-only trigger — no leading icon slot and no hover chevron. */
  textOnly?: boolean;
  /** Optional leading icon replacement shown on hover when the pill is inactive. */
  hoverIcon?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  className?: string;
  labelClassName?: string;
  /** Additional classes for the persistent trailing chevron. */
  chevronClassName?: string;
  labelStyle?: React.CSSProperties;
  dataTestId?: string;
  disabled?: boolean;
}

export const SelectorPill = forwardRef<HTMLButtonElement, SelectorPillProps>(
  (
    {
      icon,
      label,
      labelContent,
      title,
      tooltip,
      tooltipFramed = false,
      tooltipFramedWide = false,
      tooltipPosition = "top",
      tooltipMouseEnterDelay = 400,
      active = false,
      activeTone = "primary",
      danger = false,
      size = "sm",
      appearance = "default",
      trailingChevron = false,
      textOnly = false,
      hoverIcon,
      onClick,
      onMouseDown,
      onMouseEnter,
      onMouseLeave,
      onFocus,
      onBlur,
      ariaLabel,
      ariaExpanded,
      className = "",
      labelClassName,
      chevronClassName,
      labelStyle,
      dataTestId,
      disabled,
    },
    ref
  ) => {
    const idleColor = "text-text-1";
    const activeColor = activeTone === "neutral" ? idleColor : "text-primary-6";
    const labelColor = danger
      ? "text-primary-6"
      : active
        ? activeColor
        : idleColor;
    const iconSize = ICON_SIZES[size];
    const iconColor = danger ? "text-primary-6" : idleColor;
    const chevronColor = danger
      ? "text-primary-6"
      : active
        ? activeColor
        : idleColor;
    const appearanceClasses =
      appearance === "bare"
        ? ""
        : active
          ? PILL_CONTROL_ACTIVE_SURFACE_CLASS
          : PILL_CONTROL_HOVER_CLASS;

    // Controlled tooltip visibility so that opening the dropdown (active=true)
    // immediately hides the tooltip instead of leaving it covering the panel.
    // We track hover/focus intent only; the effective visibility is gated on
    // `active` so no effect is needed to re-hide when the pill activates.
    const [hoverIntent, setHoverIntent] = useState(false);
    const tooltipVisible = hoverIntent && !active;
    const handleTooltipVisibleChange = useCallback((next: boolean) => {
      setHoverIntent(next);
    }, []);

    const buttonSizeClass = label
      ? SIZE_CLASSES[size]
      : "h-[28px] w-[28px] justify-center px-0";

    const button = (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={ariaExpanded}
        data-testid={dataTestId}
        title={tooltip ? undefined : (title ?? label)}
        className={`group/pill flex min-w-0 items-center rounded-full transition-colors duration-200 focus:outline-none ${buttonSizeClass} ${labelClassName ? "font-normal" : "font-medium"} ${appearanceClasses} ${className}`}
      >
        <SelectorPillContent
          icon={icon}
          label={label}
          labelContent={labelContent}
          size={size}
          active={active}
          trailingChevron={trailingChevron}
          textOnly={textOnly}
          hoverIcon={hoverIcon}
          iconColor={iconColor}
          chevronColor={chevronColor}
          chevronClassName={chevronClassName}
          labelColor={labelColor}
          labelClassName={labelClassName}
          iconSize={iconSize}
          labelStyle={labelStyle}
        />
      </button>
    );

    if (tooltip) {
      return (
        <Tooltip
          content={tooltip}
          position={tooltipPosition}
          mouseEnterDelay={tooltipMouseEnterDelay}
          popupVisible={tooltipVisible}
          onVisibleChange={handleTooltipVisibleChange}
          framedPanel={tooltipFramed}
          framedPanelWide={tooltipFramedWide}
        >
          {button}
        </Tooltip>
      );
    }

    return button;
  }
);

SelectorPill.displayName = "SelectorPill";

export default SelectorPill;
