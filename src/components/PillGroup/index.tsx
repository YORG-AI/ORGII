/**
 * PillGroup
 *
 * Shared pill row used by the session creator's model/source row,
 * repo/branch row, and the chat input model+source pill.
 *
 * Layout:
 *   [icon label]  |  [icon label]  |  [icon label]
 *
 * Resting state has no border/background — visible segments render as plain
 * icon+label runs separated by a thin `|` divider. When the cursor enters a
 * segment (or the segment becomes `active`, e.g. its dropdown is open), that
 * segment morphs into an independent rounded pill with a hover/active
 * background, the icon swaps to a chevron, and the dividers adjacent to it
 * disappear so the pill stands alone. Other segments stay transparent.
 *
 * A segment can opt into reveal-on-hover behaviour via `revealOnHover`: it
 * stays hidden until the cursor enters any segment in the group (or the
 * segment is `active` / `forceVisible`). The chat input bottom pill uses
 * this for the source segment so the row collapses to model-only at rest.
 *
 * Each segment is its own button with its own click/tooltip — they are
 * independent triggers, not two halves of the same control.
 */
import React, { memo, useCallback, useRef, useState } from "react";

import SelectorPill from "@src/components/SelectorPill";
import type { TooltipProps } from "@src/components/Tooltip";

const HOVER_LEAVE_DELAY_MS = 200;
const GHOST_PILL_HOVER_SURFACE_CLASS = "enabled:hover:!bg-fill-3";
const GHOST_PILL_ACTIVE_SURFACE_CLASS = "!bg-fill-3";

export interface PillGroupSegmentButtonProps {
  active: boolean;
  segmentClassName?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick?: (event: React.MouseEvent) => void;
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
}

export interface PillGroupSegment {
  /** Stable id used as React key and to derive aria attributes */
  id: string;
  /** Leading icon (rendered at rest and on hover). Pass null for text-only segments. */
  icon: React.ReactNode;
  /** Visible label */
  label: string;
  /** Native title attribute (fallback when no `tooltip` is provided) */
  title?: string;
  /**
   * Styled tooltip content (mutually exclusive with `title`). Accepts either
   * a plain string or a React node — pass `<KeyboardShortcutTooltipContent />`
   * to attach a shortcut chip next to the label.
   */
  tooltip?: React.ReactNode;
  /**
   * When true, the tooltip renders in the framed-panel style used by the
   * chat-panel header buttons (light background, border, arrow) instead of
   * the default dark bubble.
   */
  tooltipFramed?: boolean;
  /** Widen framed-panel tooltips for long breadcrumb content. */
  tooltipFramedWide?: boolean;
  /** Tooltip placement relative to the segment. Defaults to `top`. */
  tooltipPosition?: TooltipProps["position"];
  /** Delay before showing the segment tooltip. */
  tooltipMouseEnterDelay?: number;
  /** ARIA label for the underlying button */
  ariaLabel?: string;
  /** Whether this segment's dropdown/selector is open. Forces pill styling. */
  active?: boolean;
  /** Render label in danger color to signal a missing required selection */
  danger?: boolean;
  /** Disable interaction — useful while a sibling is loading */
  disabled?: boolean;
  /** Click handler for the segment */
  onClick?: (event: React.MouseEvent) => void;
  /** Stable selector for rendered UI tests */
  dataTestId?: string;
  /** Open selector-style pills on press start for glass/driver hit-test parity */
  activateOnMouseDown?: boolean;
  /** Hard cap on the label width — applies overflow ellipsis */
  maxLabelWidth?: number;
  /** Forwarded ref for the underlying button — useful for dropdown positioning */
  buttonRef?: React.Ref<HTMLButtonElement>;
  /**
   * When true, the segment is hidden until the cursor enters the group, the
   * segment is `active`, or `forceVisible` is set. Used by chat-input model
   * pills to show only the model at rest and reveal the source on hover.
   */
  revealOnHover?: boolean;
  /**
   * Forces a `revealOnHover` segment to remain visible even when the group
   * is not hovered (e.g. no source selected yet — keep the placeholder
   * visible so users can click it).
   */
  forceVisible?: boolean;
  /**
   * Optional custom trigger renderer. When set, PillGroup delegates button
   * rendering to this callback instead of the default {@link SelectorPill}.
   * Used by model+effort pills where the effort segment wraps
   * {@link ModelPropertiesDropdown} around the trigger.
   */
  renderButton?: (props: PillGroupSegmentButtonProps) => React.ReactNode;
}

interface PillGroupSegmentRowProps {
  segment: PillGroupSegment;
  index: number;
  visibleMap: boolean[];
  segments: PillGroupSegment[];
  hoveredIndex: number | null;
  segmentClassName?: string;
  strongSurface: boolean;
  onEnter: (index: number) => void;
  onLeave: (index: number) => void;
}

const PillGroupSegmentRow: React.FC<PillGroupSegmentRowProps> = ({
  segment,
  index,
  visibleMap,
  segments,
  hoveredIndex,
  segmentClassName,
  strongSurface,
  onEnter,
  onLeave,
}) => {
  const isVisible = visibleMap[index];
  if (!isVisible) return null;

  const isHovered = hoveredIndex === index;
  const isActive = !!segment.active;
  const isPillStyled = isHovered || isActive;
  const usesFill3Surface = strongSurface;
  const resolvedSegmentClassName = `${segmentClassName ?? ""} ${
    usesFill3Surface
      ? isActive
        ? GHOST_PILL_ACTIVE_SURFACE_CLASS
        : GHOST_PILL_HOVER_SURFACE_CLASS
      : ""
  }`.trim();

  let previousVisibleIndex = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (visibleMap[i]) {
      previousVisibleIndex = i;
      break;
    }
  }
  const previous =
    previousVisibleIndex >= 0 ? segments[previousVisibleIndex] : undefined;
  const previousIsPilled =
    !!previous && (hoveredIndex === previousVisibleIndex || !!previous.active);
  const showLeadingDivider =
    previousVisibleIndex >= 0 && !isPillStyled && !previousIsPilled;

  const handleMouseDown:
    | React.MouseEventHandler<HTMLButtonElement>
    | undefined =
    segment.activateOnMouseDown && segment.onClick
      ? (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          segment.onClick?.(event);
        }
      : undefined;

  const buttonProps: PillGroupSegmentButtonProps = {
    active: isActive,
    segmentClassName: resolvedSegmentClassName,
    onMouseEnter: () => onEnter(index),
    onMouseLeave: () => onLeave(index),
    onFocus: () => onEnter(index),
    onBlur: () => onLeave(index),
    onClick: segment.onClick,
    onMouseDown: handleMouseDown,
  };

  /* eslint-disable react-hooks/refs -- forward segment.buttonRef without reading .current; custom renderButton owns its refs */
  const button = segment.renderButton ? (
    segment.renderButton(buttonProps)
  ) : (
    <SelectorPill
      ref={segment.buttonRef}
      icon={segment.icon}
      label={segment.label}
      title={segment.title}
      active={isActive}
      danger={segment.danger}
      disabled={segment.disabled}
      tooltip={segment.tooltip}
      tooltipFramed={segment.tooltipFramed}
      tooltipFramedWide={segment.tooltipFramedWide}
      tooltipPosition={segment.tooltipPosition ?? undefined}
      tooltipMouseEnterDelay={segment.tooltipMouseEnterDelay}
      ariaLabel={segment.ariaLabel}
      dataTestId={segment.dataTestId}
      appearance={usesFill3Surface ? "bare" : "default"}
      className={resolvedSegmentClassName}
      labelStyle={
        segment.maxLabelWidth ? { maxWidth: segment.maxLabelWidth } : undefined
      }
      onClick={segment.onClick}
      onMouseDown={handleMouseDown}
      onMouseEnter={buttonProps.onMouseEnter}
      onMouseLeave={buttonProps.onMouseLeave}
      onFocus={buttonProps.onFocus}
      onBlur={buttonProps.onBlur}
      size="sm"
    />
  );
  /* eslint-enable react-hooks/refs */

  return (
    <>
      {previousVisibleIndex >= 0 && (
        <span
          aria-hidden
          className={`inline-flex h-3 w-px shrink-0 bg-border-2 transition-opacity duration-150 ${
            showLeadingDivider ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      {button}
    </>
  );
};

export interface PillGroupProps {
  segments: PillGroupSegment[];
  /** Optional class on the outer wrapper (e.g. flex-wrap, text size overrides) */
  className?: string;
  /** Optional class applied to every segment button. */
  segmentClassName?: string;
  /** Use a higher-contrast hover/open surface for prominent selector rows. */
  strongSurface?: boolean;
}

const PillGroup: React.FC<PillGroupProps> = memo(
  ({ segments, className, segmentClassName, strongSurface = false }) => {
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const [groupHovered, setGroupHovered] = useState(false);
    const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleEnter = useCallback((index: number) => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      setHoveredIndex(index);
      setGroupHovered(true);
    }, []);

    const handleLeave = useCallback((index: number) => {
      setHoveredIndex((current) => (current === index ? null : current));
    }, []);

    const handleGroupLeave = useCallback(() => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = setTimeout(() => {
        setGroupHovered(false);
        setHoveredIndex(null);
      }, HOVER_LEAVE_DELAY_MS);
    }, []);

    const handleGroupEnter = useCallback(() => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      setGroupHovered(true);
    }, []);

    // Decide which segments are visible right now. A `revealOnHover` segment is
    // visible only while the group is hovered, the segment is `active`, or it
    // is `forceVisible`.
    const groupHasActive = segments.some((s) => s.active);
    const visibleMap = segments.map((segment) => {
      if (!segment.revealOnHover) return true;
      if (segment.forceVisible) return true;
      if (segment.active) return true;
      return groupHovered || groupHasActive;
    });

    return (
      <div
        className={`inline-flex items-center text-[12px] font-medium ${className ?? ""}`}
        onMouseEnter={handleGroupEnter}
        onMouseLeave={handleGroupLeave}
      >
        {segments.map((segment, index) => (
          <PillGroupSegmentRow
            key={segment.id}
            segment={segment}
            index={index}
            visibleMap={visibleMap}
            segments={segments}
            hoveredIndex={hoveredIndex}
            segmentClassName={segmentClassName}
            strongSurface={strongSurface}
            onEnter={handleEnter}
            onLeave={handleLeave}
          />
        ))}
      </div>
    );
  }
);

PillGroup.displayName = "PillGroup";

export default PillGroup;
