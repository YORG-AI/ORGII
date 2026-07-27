/**
 * Native Tooltip Component
 *
 * Native tooltip with native implementation.
 *
 *
 * Features:
 * - Full API compatibility
 * - Multiple positions
 * - Hover/click/focus triggers
 * - Customizable delay
 * - Arrow indicator
 * - Dark/light themes
 *
 * @example
 * ```tsx
 * import Tooltip from "@src/components/Tooltip";
 *
 * // Simple tooltip
 * <Tooltip content="Tooltip text">
 *   <button>Hover me</button>
 * </Tooltip>
 *
 * // With custom position
 * <Tooltip content="Tooltip text" position="top">
 *   <button>Hover me</button>
 * </Tooltip>
 * ```
 */
import React, {
  cloneElement,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactDOM from "react-dom";

import { getViewportSize } from "@src/util/ui/window/viewport";

import "./index.scss";

/**
 * Apply a value to a React ref regardless of whether it is a callback ref or
 * a mutable ref object. Kept at module scope so the argument is a plain
 * parameter (not a prop-derived identifier), which lets us legitimately
 * assign through ref.current without tripping `react-hooks/immutability`.
 */
function applyRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (ref == null) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<T | null>).current = value;
}

type TooltipCoordinates = { top: number; left: number };

type TooltipOverflow = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type TooltipPlacementCandidate = {
  position: TooltipPosition;
  coordinates: TooltipCoordinates;
  overflow: TooltipOverflow;
  overflowScore: number;
};

type TooltipRectLike = Pick<
  DOMRect,
  "top" | "right" | "bottom" | "left" | "width" | "height"
>;

type TooltipSizeLike = Pick<DOMRect, "width" | "height">;

type TooltipViewport = { width: number; height: number; padding: number };

type TooltipPositionSide = "top" | "right" | "bottom" | "left";

const TOOLTIP_OPPOSITE_SIDE: Record<TooltipPositionSide, TooltipPositionSide> =
  {
    top: "bottom",
    right: "left",
    bottom: "top",
    left: "right",
  };

function getTooltipPositionSide(
  position: TooltipPosition
): TooltipPositionSide {
  return position.split("-")[0] as TooltipPositionSide;
}

function withTooltipPositionSide(
  position: TooltipPosition,
  side: TooltipPositionSide
): TooltipPosition {
  const alignment = position.includes("-") ? position.split("-")[1] : "";
  return alignment ? (`${side}-${alignment}` as TooltipPosition) : side;
}

function getTooltipFallbackPositions(
  position: TooltipPosition
): TooltipPosition[] {
  const side = getTooltipPositionSide(position);
  const opposite = withTooltipPositionSide(
    position,
    TOOLTIP_OPPOSITE_SIDE[side]
  );
  const positions = [position, opposite];

  if (!position.endsWith("-start")) {
    positions.push(`${side}-start` as TooltipPosition);
    positions.push(
      `${getTooltipPositionSide(opposite)}-start` as TooltipPosition
    );
  }

  if (!position.endsWith("-end")) {
    positions.push(`${side}-end` as TooltipPosition);
    positions.push(
      `${getTooltipPositionSide(opposite)}-end` as TooltipPosition
    );
  }

  return Array.from(new Set(positions));
}

function getTooltipCoordinates(
  position: TooltipPosition,
  triggerRect: TooltipRectLike,
  tooltipRect: TooltipSizeLike,
  gap: number
): TooltipCoordinates {
  switch (position) {
    case "top":
      return {
        top: triggerRect.top - tooltipRect.height - gap,
        left: triggerRect.left + (triggerRect.width - tooltipRect.width) / 2,
      };
    case "top-start":
      return {
        top: triggerRect.top - tooltipRect.height - gap,
        left: triggerRect.left,
      };
    case "top-end":
      return {
        top: triggerRect.top - tooltipRect.height - gap,
        left: triggerRect.right - tooltipRect.width,
      };
    case "bottom":
      return {
        top: triggerRect.bottom + gap,
        left: triggerRect.left + (triggerRect.width - tooltipRect.width) / 2,
      };
    case "bottom-start":
      return {
        top: triggerRect.bottom + gap,
        left: triggerRect.left,
      };
    case "bottom-end":
      return {
        top: triggerRect.bottom + gap,
        left: triggerRect.right - tooltipRect.width,
      };
    case "left":
      return {
        top: triggerRect.top + (triggerRect.height - tooltipRect.height) / 2,
        left: triggerRect.left - tooltipRect.width - gap,
      };
    case "left-start":
      return {
        top: triggerRect.top,
        left: triggerRect.left - tooltipRect.width - gap,
      };
    case "left-end":
      return {
        top: triggerRect.bottom - tooltipRect.height,
        left: triggerRect.left - tooltipRect.width - gap,
      };
    case "right":
      return {
        top: triggerRect.top + (triggerRect.height - tooltipRect.height) / 2,
        left: triggerRect.right + gap,
      };
    case "right-start":
      return {
        top: triggerRect.top,
        left: triggerRect.right + gap,
      };
    case "right-end":
      return {
        top: triggerRect.bottom - tooltipRect.height,
        left: triggerRect.right + gap,
      };
  }
}

function getTooltipOverflow(
  coordinates: TooltipCoordinates,
  tooltipRect: TooltipSizeLike,
  viewport: TooltipViewport
): TooltipOverflow {
  return {
    top: Math.max(0, viewport.padding - coordinates.top),
    right: Math.max(
      0,
      coordinates.left + tooltipRect.width - (viewport.width - viewport.padding)
    ),
    bottom: Math.max(
      0,
      coordinates.top +
        tooltipRect.height -
        (viewport.height - viewport.padding)
    ),
    left: Math.max(0, viewport.padding - coordinates.left),
  };
}

function getTooltipOverflowScore(overflow: TooltipOverflow): number {
  return overflow.top + overflow.right + overflow.bottom + overflow.left;
}

function getBestTooltipCandidate(
  position: TooltipPosition,
  triggerRect: TooltipRectLike,
  tooltipRect: TooltipSizeLike,
  gap: number,
  viewport: TooltipViewport,
  smartPlacement: boolean
): TooltipPlacementCandidate {
  const candidates = (
    smartPlacement ? getTooltipFallbackPositions(position) : [position]
  ).map((candidatePosition) => {
    const coordinates = getTooltipCoordinates(
      candidatePosition,
      triggerRect,
      tooltipRect,
      gap
    );
    const overflow = getTooltipOverflow(coordinates, tooltipRect, viewport);
    return {
      position: candidatePosition,
      coordinates,
      overflow,
      overflowScore: getTooltipOverflowScore(overflow),
    };
  });

  return candidates.reduce((best, candidate) =>
    candidate.overflowScore < best.overflowScore ? candidate : best
  );
}

export type TooltipPosition =
  | "top"
  | "top-start"
  | "top-end"
  | "bottom"
  | "bottom-start"
  | "bottom-end"
  | "left"
  | "left-start"
  | "left-end"
  | "right"
  | "right-start"
  | "right-end";

export interface TooltipProps {
  /**
   * Tooltip content
   */
  content: React.ReactNode;

  /**
   * Tooltip position
   * @default 'top'
   */
  position?: TooltipPosition;

  /**
   * Trigger type
   * @default 'hover'
   */
  trigger?: "hover" | "click" | "focus";

  /**
   * Show delay (ms)
   * @default 100
   */
  mouseEnterDelay?: number;

  /**
   * Hide delay (ms)
   * @default 100
   */
  mouseLeaveDelay?: number;

  /**
   * Disabled state
   */
  disabled?: boolean;

  /**
   * Controlled visible state
   */
  popupVisible?: boolean;

  /**
   * Default visible state
   */
  defaultPopupVisible?: boolean;

  /**
   * Visible change handler
   */
  onVisibleChange?: (visible: boolean) => void;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Tooltip color (theme)
   * @default 'dark'
   */
  color?: "dark" | "light";

  /**
   * Custom background color
   */
  backgroundColor?: string;

  /**
   * Child element (trigger)
   */
  children: React.ReactNode;

  /**
   * Popup container
   */
  getPopupContainer?: () => HTMLElement;

  /**
   * Whether to show the arrow indicator
   * @default true
   */
  showArrow?: boolean;

  /**
   * Use panel styling (bg-bg-2 + border-border-2)
   * @default false
   */
  panelStyle?: boolean;

  /**
   * Use bg-2 with a 1px border and no arrow indicator.
   * @default false
   */
  framedPanel?: boolean;

  /**
   * Widen the framed-panel content area for long breadcrumb tooltips
   * (e.g. model pill account › full model id).
   * @default false
   */
  framedPanelWide?: boolean;

  /**
   * Pick a nearby placement when the requested placement would overflow.
   * @default false
   */
  smartPlacement?: boolean;
}

const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(
  (
    {
      content,
      position = "top",
      trigger = "hover",
      mouseEnterDelay = 100,
      mouseLeaveDelay = 100,
      disabled = false,
      popupVisible,
      defaultPopupVisible = false,
      onVisibleChange,
      className = "",
      style,
      color = "dark",
      backgroundColor,
      children,
      getPopupContainer,
      showArrow = true,
      panelStyle = false,
      framedPanel = false,
      framedPanelWide = false,
      smartPlacement = false,
    },
    _ref
  ) => {
    const [internalVisible, setInternalVisible] = useState(defaultPopupVisible);
    const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
    const [arrowOffset, setArrowOffset] = useState({ left: 0, top: 0 });
    const [positionReady, setPositionReady] = useState(false);
    const [triggerElement, setTriggerElement] = useState<HTMLElement | null>(
      null
    );
    const tooltipRef = useRef<HTMLDivElement>(null);
    const enterTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const leaveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

    // Callback ref for trigger element
    const triggerRef = useCallback((node: HTMLElement | null) => {
      setTriggerElement(node);
    }, []);

    const isControlled = popupVisible !== undefined;
    const currentVisible = isControlled ? popupVisible : internalVisible;
    const usesFramedSurface = framedPanel || (!panelStyle && !backgroundColor);

    const updatePosition = useCallback(() => {
      if (!triggerElement || !tooltipRef.current) return;

      const triggerRect = triggerElement.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const gap = usesFramedSurface ? 8 : 12;

      const padding = 8;
      const { width: vpWidth, height: vpHeight } = getViewportSize();
      const viewport: TooltipViewport = {
        width: vpWidth,
        height: vpHeight,
        padding,
      };
      const candidate = getBestTooltipCandidate(
        position,
        triggerRect,
        tooltipRect,
        gap,
        viewport,
        smartPlacement
      );
      let top = candidate.coordinates.top;
      let left = candidate.coordinates.left;

      top = Math.max(
        padding,
        Math.min(top, vpHeight - tooltipRect.height - padding)
      );
      left = Math.max(
        padding,
        Math.min(left, vpWidth - tooltipRect.width - padding)
      );

      // Calculate arrow offset to keep it pointing at trigger center
      // when tooltip is clamped by viewport boundaries
      // Only apply offset for centered positions (not -start or -end variants)
      let arrowLeftOffset = 0;
      let arrowTopOffset = 0;

      const selectedPosition = candidate.position;
      const isCenteredPosition =
        selectedPosition === "top" ||
        selectedPosition === "bottom" ||
        selectedPosition === "left" ||
        selectedPosition === "right";

      if (isCenteredPosition) {
        if (selectedPosition === "top" || selectedPosition === "bottom") {
          const triggerCenterX = triggerRect.left + triggerRect.width / 2;
          const tooltipCenterX = left + tooltipRect.width / 2;
          arrowLeftOffset = triggerCenterX - tooltipCenterX;
        } else if (
          selectedPosition === "left" ||
          selectedPosition === "right"
        ) {
          const triggerCenterY = triggerRect.top + triggerRect.height / 2;
          const tooltipCenterY = top + tooltipRect.height / 2;
          arrowTopOffset = triggerCenterY - tooltipCenterY;
        }
      }

      setTooltipPosition({ top, left });
      setArrowOffset({ left: arrowLeftOffset, top: arrowTopOffset });
      setPositionReady(true);
    }, [position, smartPlacement, triggerElement, usesFramedSurface]);

    useEffect(() => {
      if (currentVisible) {
        // Reset position ready state and calculate position
        setPositionReady(false);
        // Use RAF to ensure tooltip is rendered before calculating position
        requestAnimationFrame(() => {
          updatePosition();
        });

        window.addEventListener("scroll", updatePosition, true);
        window.addEventListener("resize", updatePosition);

        return () => {
          window.removeEventListener("scroll", updatePosition, true);
          window.removeEventListener("resize", updatePosition);
        };
      } else {
        setPositionReady(false);
      }
    }, [currentVisible, updatePosition]);

    const show = useCallback(() => {
      if (disabled) return;

      clearTimeout(leaveTimerRef.current);
      enterTimerRef.current = setTimeout(() => {
        if (!isControlled) {
          setInternalVisible(true);
        }
        onVisibleChange?.(true);
      }, mouseEnterDelay);
    }, [disabled, isControlled, onVisibleChange, mouseEnterDelay]);

    // Force-hide when disabled flips true (e.g. the trigger entered an
    // "active"/open state and the tooltip would otherwise occlude a dropdown).
    useEffect(() => {
      if (!disabled) return;
      clearTimeout(enterTimerRef.current);
      clearTimeout(leaveTimerRef.current);
      if (!isControlled) {
        setInternalVisible(false);
      }
      onVisibleChange?.(false);
    }, [disabled, isControlled, onVisibleChange]);

    const hide = useCallback(() => {
      clearTimeout(enterTimerRef.current);
      leaveTimerRef.current = setTimeout(() => {
        if (!isControlled) {
          setInternalVisible(false);
        }
        onVisibleChange?.(false);
      }, mouseLeaveDelay);
    }, [isControlled, onVisibleChange, mouseLeaveDelay]);

    const handleMouseEnter = useCallback(() => {
      if (trigger === "hover") {
        show();
      }
    }, [trigger, show]);

    const handleMouseLeave = useCallback(() => {
      if (trigger === "hover") {
        hide();
      }
    }, [trigger, hide]);

    const handleClick = useCallback(() => {
      if (trigger === "click") {
        if (currentVisible) {
          hide();
        } else {
          show();
        }
        return;
      }
      // For hover triggers, a click on the trigger means the user has
      // committed to acting on what the tooltip describes. Leaving the
      // tooltip up after the click reads as stale — the underlying state
      // (selected app, follow target, etc.) usually flipped, so the
      // label may no longer match what's under the cursor. Dismiss
      // immediately; the next mouse-leave/enter cycle re-evaluates.
      if (trigger === "hover" && currentVisible) {
        clearTimeout(enterTimerRef.current);
        clearTimeout(leaveTimerRef.current);
        if (!isControlled) {
          setInternalVisible(false);
        }
        onVisibleChange?.(false);
      }
    }, [trigger, currentVisible, show, hide, isControlled, onVisibleChange]);

    const handleFocus = useCallback(() => {
      if (trigger === "focus") {
        show();
      }
    }, [trigger, show]);

    const handleBlur = useCallback(() => {
      if (trigger === "focus") {
        hide();
      }
    }, [trigger, hide]);

    // Cleanup timers
    useEffect(() => {
      return () => {
        clearTimeout(enterTimerRef.current);
        clearTimeout(leaveTimerRef.current);
      };
    }, []);

    // Clone child and attach event handlers
    type ElementProps = {
      ref?: React.Ref<HTMLElement>;
      onMouseEnter?: (e: React.MouseEvent) => void;
      onMouseLeave?: (e: React.MouseEvent) => void;
      onClick?: (e: React.MouseEvent) => void;
      onFocus?: (e: React.FocusEvent) => void;
      onBlur?: (e: React.FocusEvent) => void;
      [key: string]: unknown;
    };

    // Clone child element and attach event handlers
    // Callback refs are safe to pass during render - this is a false positive
    const wrappedChildren = useMemo(() => {
      if (!isValidElement(children)) {
        return children;
      }

      const getElementProps = (
        element: React.ReactElement<ElementProps>
      ): ElementProps => {
        return element.props as ElementProps;
      };

      const originalProps = getElementProps(
        children as React.ReactElement<ElementProps>
      );

      // Preserve any ref the child already had (e.g. a parent's forwardRef
      // used for dropdown positioning). Without this, wrapping an element
      // in Tooltip would silently break refs like useDropdownEngine's
      // triggerRef, causing click-to-open dropdowns to never position.
      const childRef = originalProps.ref;
      const composedRef = (node: HTMLElement | null) => {
        triggerRef(node);
        applyRef(childRef, node);
      };

      // eslint-disable-next-line react-hooks/refs
      return cloneElement(children as React.ReactElement<ElementProps>, {
        ref: composedRef,
        onMouseEnter: (e: React.MouseEvent) => {
          handleMouseEnter();
          originalProps.onMouseEnter?.(e);
        },
        onMouseLeave: (e: React.MouseEvent) => {
          handleMouseLeave();
          originalProps.onMouseLeave?.(e);
        },
        onClick: (e: React.MouseEvent) => {
          handleClick();
          originalProps.onClick?.(e);
        },
        onFocus: (e: React.FocusEvent) => {
          handleFocus();
          originalProps.onFocus?.(e);
        },
        onBlur: (e: React.FocusEvent) => {
          handleBlur();
          originalProps.onBlur?.(e);
        },
      });
    }, [
      children,
      triggerRef,
      handleMouseEnter,
      handleMouseLeave,
      handleClick,
      handleFocus,
      handleBlur,
    ]);

    const tooltipClasses = [
      "native-tooltip",
      `native-tooltip-${position}`,
      `native-tooltip-${color}`,
      currentVisible && positionReady && "native-tooltip-visible",
      trigger === "click" && "native-tooltip-interactive",
      panelStyle && "native-tooltip-panel",
      usesFramedSurface && "native-tooltip-framed-panel",
      framedPanelWide && "native-tooltip-framed-panel-wide",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const tooltipStyle = {
      ...tooltipPosition,
      ...style,
      ...(backgroundColor ? { backgroundColor } : {}),
    };

    const tooltipContent = currentVisible ? (
      <div
        ref={tooltipRef}
        className={tooltipClasses}
        style={tooltipStyle}
        onMouseEnter={trigger === "hover" ? show : undefined}
        onMouseLeave={trigger === "hover" ? hide : undefined}
      >
        <div className="native-tooltip-content">
          <div className="native-tooltip-content-inner">{content}</div>
        </div>
        {showArrow && !usesFramedSurface && (
          <div
            className="native-tooltip-arrow"
            style={{
              transform: `translate(${arrowOffset.left}px, ${arrowOffset.top}px) rotate(45deg)`,
            }}
          />
        )}
      </div>
    ) : null;

    const tooltipPortal =
      tooltipContent && typeof document !== "undefined"
        ? ReactDOM.createPortal(
            tooltipContent,
            getPopupContainer?.() || document.body
          )
        : null;

    return (
      <>
        {wrappedChildren}
        {tooltipPortal}
      </>
    );
  }
);

Tooltip.displayName = "Tooltip";

export default Tooltip;
