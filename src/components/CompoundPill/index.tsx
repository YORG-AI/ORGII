/**
 * CompoundPill
 *
 * Reusable two-segment pill button used by ControlButtons.
 * Primary segment is always visible; secondary segment reveals on hover
 * or can be forced visible via `secondaryForceVisible`.
 * Optional clear segment (Eraser icon) appears on the far right when
 * `onClearClick` is provided — only rendered when there is an active selection.
 */
import { ArrowLeftRight, Eraser } from "lucide-react";
import React, { memo, useCallback, useRef, useState } from "react";

import Tooltip from "@src/components/Tooltip";

import {
  PILL_CONTROL_ACTIVE_SURFACE_CLASS,
  PILL_CONTROL_HOVER_CLASS,
  PILL_SM_ICON_CONTAINER_CLASS,
  PILL_SM_ICON_SIZE,
} from "./config";

const HOVER_LEAVE_DELAY_MS = 200;

export interface CompoundPillProps {
  /** Primary (left) segment */
  primaryIcon: React.ReactNode;
  primaryLabel: string;
  /** Native title fallback */
  primaryTitle?: string;
  /** Styled tooltip text */
  primaryTooltip?: string;
  primaryActive?: boolean;
  onPrimaryClick: () => void;
  primaryAriaLabel?: string;
  primaryMaxWidth?: number;

  /** Secondary (right) segment — revealed on hover */
  secondaryIcon?: React.ReactNode;
  secondaryLabel?: string;
  /** Styled tooltip text for secondary segment */
  secondaryTooltip?: string;
  secondaryActive?: boolean;
  onSecondaryClick?: (event: React.MouseEvent) => void;
  secondaryAriaLabel?: string;
  secondaryMaxWidth?: number;
  secondaryForceVisible?: boolean;

  /** Clear/reset segment — icon-only Eraser button on the far right.
   *  Only rendered when this prop is provided. */
  onClearClick?: (event: React.MouseEvent) => void;
  clearAriaLabel?: string;

  /** Whether the outer container shows its "open" border/shadow */
  containerActive?: boolean;
}

const CompoundPill: React.FC<CompoundPillProps> = memo(
  ({
    primaryIcon,
    primaryLabel,
    primaryTitle,
    primaryTooltip,
    primaryActive = false,
    onPrimaryClick,
    primaryAriaLabel,
    primaryMaxWidth = 160,

    secondaryIcon,
    secondaryLabel,
    secondaryTooltip,
    secondaryActive = false,
    onSecondaryClick,
    secondaryAriaLabel,
    secondaryMaxWidth = 80,
    secondaryForceVisible = false,

    onClearClick,
    clearAriaLabel,

    containerActive = false,
  }) => {
    const iconSize = PILL_SM_ICON_SIZE;
    const hasSecondary = Boolean(secondaryLabel);
    const hasClear = Boolean(onClearClick);

    // JS-driven hover with leave delay so moving between segments doesn't collapse
    const [isExpanded, setIsExpanded] = useState(false);
    const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleMouseEnter = useCallback(() => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      setIsExpanded(true);
    }, []);

    const handleMouseLeave = useCallback(() => {
      leaveTimerRef.current = setTimeout(
        () => setIsExpanded(false),
        HOVER_LEAVE_DELAY_MS
      );
    }, []);

    const showExtra = isExpanded || containerActive;

    const primaryRounding =
      !hasSecondary && !hasClear
        ? "rounded-full pl-3 pr-3"
        : secondaryForceVisible || showExtra
          ? "rounded-l-full pl-3 pr-2"
          : "rounded-full pl-3 pr-3";

    return (
      <div
        className={`group/primary flex h-[28px] items-center rounded-full border border-solid text-[12px] font-medium transition-all duration-200 ${
          containerActive
            ? "border-border-2 bg-bg-2"
            : isExpanded
              ? "border-border-2 bg-bg-2"
              : "border-transparent"
        }`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <Tooltip
          content={primaryTooltip ?? ""}
          position="top"
          mouseEnterDelay={400}
          disabled={!primaryTooltip}
        >
          <button
            onClick={onPrimaryClick}
            className={`group/primarybtn flex h-full items-center gap-2 transition-colors focus:outline-none ${
              primaryActive
                ? PILL_CONTROL_ACTIVE_SURFACE_CLASS
                : PILL_CONTROL_HOVER_CLASS
            } ${primaryRounding}`}
            aria-label={primaryAriaLabel}
            title={primaryTooltip ? undefined : (primaryTitle ?? primaryLabel)}
          >
            <span className={PILL_SM_ICON_CONTAINER_CLASS}>
              <span
                className={
                  primaryActive ? "hidden" : "group-hover/primarybtn:hidden"
                }
              >
                {primaryIcon}
              </span>
              <ArrowLeftRight
                size={iconSize}
                strokeWidth={1.75}
                className={
                  primaryActive
                    ? "block text-primary-6"
                    : "hidden text-text-1 group-hover/primarybtn:block"
                }
              />
            </span>
            <span
              className={`truncate ${primaryActive ? "text-primary-6" : "text-text-1"}`}
              style={{ maxWidth: primaryMaxWidth }}
            >
              {primaryLabel}
            </span>
          </button>
        </Tooltip>

        {hasSecondary && (
          <>
            <div
              className={`h-3 w-px shrink-0 border-l border-solid border-border-2 ${
                secondaryForceVisible || showExtra ? "block" : "hidden"
              }`}
            />
            <Tooltip
              content={secondaryTooltip ?? ""}
              position="top"
              mouseEnterDelay={400}
              disabled={!secondaryTooltip}
            >
              <button
                onClick={onSecondaryClick}
                className={`group/secondary h-full items-center gap-2 ${hasClear ? "pl-2 pr-2" : "rounded-r-full pl-2 pr-3"} transition-colors focus:outline-none ${
                  secondaryActive
                    ? PILL_CONTROL_ACTIVE_SURFACE_CLASS
                    : PILL_CONTROL_HOVER_CLASS
                } ${secondaryForceVisible || showExtra ? "flex" : "hidden"}`}
                aria-label={secondaryAriaLabel}
                title={secondaryTooltip ? undefined : secondaryLabel}
              >
                <span className={PILL_SM_ICON_CONTAINER_CLASS}>
                  <span
                    className={
                      secondaryActive
                        ? "hidden"
                        : "group-hover/secondary:hidden"
                    }
                  >
                    {secondaryIcon}
                  </span>
                  <ArrowLeftRight
                    size={iconSize}
                    strokeWidth={1.75}
                    className={
                      secondaryActive
                        ? "block text-primary-6"
                        : "hidden text-text-1 group-hover/secondary:block"
                    }
                  />
                </span>
                <span
                  className={`truncate ${secondaryActive ? "text-primary-6" : "text-text-1"}`}
                  style={{ maxWidth: secondaryMaxWidth }}
                >
                  {secondaryLabel}
                </span>
              </button>
            </Tooltip>
          </>
        )}

        {hasClear && (
          <>
            <div
              className={`h-3 w-px shrink-0 border-l border-solid border-border-2 ${showExtra ? "block" : "hidden"}`}
            />
            <Tooltip
              content={clearAriaLabel ?? ""}
              position="top"
              mouseEnterDelay={400}
              disabled={!clearAriaLabel}
            >
              <button
                onClick={onClearClick}
                className={`group/clear h-full items-center rounded-r-full px-2 transition-colors focus:outline-none ${PILL_CONTROL_HOVER_CLASS} ${showExtra ? "flex" : "hidden"}`}
                aria-label={clearAriaLabel}
              >
                <Eraser
                  size={iconSize}
                  strokeWidth={1.75}
                  className="text-text-2 transition-colors group-hover/clear:text-text-1"
                />
              </button>
            </Tooltip>
          </>
        )}
      </div>
    );
  }
);

CompoundPill.displayName = "CompoundPill";

export default CompoundPill;
