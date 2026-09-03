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

import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";
import { getViewportSize } from "@src/util/ui/window/viewport";

import "./index.scss";
import {
  type TooltipPosition,
  type TooltipViewport,
  getBestTooltipCandidate,
  getTooltipPositionSide,
} from "./tooltipPlacement";

export type { TooltipPosition } from "./tooltipPlacement";

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

type TooltipChildProps = {
  ref?: React.Ref<HTMLElement>;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  onFocus?: (e: React.FocusEvent) => void;
  onBlur?: (e: React.FocusEvent) => void;
  [key: string]: unknown;
};

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
   * Controlled open state
   */
  open?: boolean;

  /**
   * Default open state
   */
  defaultOpen?: boolean;

  /**
   * Open state change handler
   */
  onOpenChange?: (open: boolean) => void;

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
      open,
      defaultOpen = false,
      onOpenChange,
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
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
    const [arrowOffset, setArrowOffset] = useState({ left: 0, top: 0 });
    const [positionReady, setPositionReady] = useState(false);
    const [triggerElement, setTriggerElement] = useState<HTMLElement | null>(
      null
    );
    const tooltipRef = useRef<HTMLDivElement>(null);
    const enterTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const leaveTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

    const hasElementChild = isValidElement(children);
    const childRef = hasElementChild
      ? (children.props as TooltipChildProps).ref
      : undefined;
    // React calls the previous callback ref with null before attaching a new
    // callback to the same node. Ignore that transient null for positioning;
    // otherwise an inline child ref produces null→node state churn and can
    // escalate into React #185. A genuinely new node still updates state.
    const triggerRef = useCallback(
      (node: HTMLElement | null) => {
        if (node !== null) {
          setTriggerElement((previous) =>
            previous === node ? previous : node
          );
        }
        applyRef(childRef, node);
      },
      [childRef]
    );

    const isControlled = open !== undefined;
    const effectiveOpen = isControlled ? open : internalOpen;
    const usesFramedSurface = framedPanel || (!panelStyle && !backgroundColor);

    const updatePosition = useCallback(() => {
      const positionedTrigger = hasElementChild ? triggerElement : null;
      if (!positionedTrigger || !tooltipRef.current) return;

      const triggerRect = positionedTrigger.getBoundingClientRect();
      // The opening animation scales the visual rect. Measure the final
      // border-box size instead, retaining fractional pixels for an exact gap.
      const tooltipSize = window.getComputedStyle(tooltipRef.current);
      const tooltipRect = {
        width: parseFloat(tooltipSize.width) || tooltipRef.current.offsetWidth,
        height:
          parseFloat(tooltipSize.height) || tooltipRef.current.offsetHeight,
      };
      const side = getTooltipPositionSide(position);
      const menuPanel =
        usesFramedSurface && (side === "left" || side === "right")
          ? positionedTrigger.closest<HTMLElement>('[role="menu"]')
          : null;
      const menuRect = menuPanel?.getBoundingClientRect();
      // Side tooltips stay aligned with their row but clear the menu's outer
      // edge, just like submenus, regardless of the row's padding/inset.
      const anchorRect = menuRect
        ? {
            top: triggerRect.top,
            bottom: triggerRect.bottom,
            height: triggerRect.height,
            left: menuRect.left,
            right: menuRect.right,
            width: menuRect.width,
          }
        : triggerRect;
      const gap = DROPDOWN_PANEL.submenuGap;
      const padding = DROPDOWN_PANEL.viewportPadding;
      const { width: vpWidth, height: vpHeight } = getViewportSize();
      const viewport: TooltipViewport = {
        width: vpWidth,
        height: vpHeight,
        padding,
      };
      const candidate = getBestTooltipCandidate(
        position,
        anchorRect,
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
    }, [
      hasElementChild,
      position,
      smartPlacement,
      triggerElement,
      usesFramedSurface,
    ]);

    useEffect(() => {
      if (effectiveOpen) {
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
    }, [effectiveOpen, updatePosition]);

    const show = useCallback(() => {
      if (disabled) return;

      clearTimeout(leaveTimerRef.current);
      enterTimerRef.current = setTimeout(() => {
        if (!isControlled) {
          setInternalOpen(true);
        }
        onOpenChange?.(true);
      }, mouseEnterDelay);
    }, [disabled, isControlled, onOpenChange, mouseEnterDelay]);

    // Force-hide when disabled flips true (e.g. the trigger entered an
    // "active"/open state and the tooltip would otherwise occlude a dropdown).
    useEffect(() => {
      if (!disabled) return;
      clearTimeout(enterTimerRef.current);
      clearTimeout(leaveTimerRef.current);
      if (!isControlled) {
        setInternalOpen(false);
      }
      onOpenChange?.(false);
    }, [disabled, isControlled, onOpenChange]);

    const hide = useCallback(() => {
      clearTimeout(enterTimerRef.current);
      leaveTimerRef.current = setTimeout(() => {
        if (!isControlled) {
          setInternalOpen(false);
        }
        onOpenChange?.(false);
      }, mouseLeaveDelay);
    }, [isControlled, onOpenChange, mouseLeaveDelay]);

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
        if (effectiveOpen) {
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
      if (trigger === "hover" && effectiveOpen) {
        clearTimeout(enterTimerRef.current);
        clearTimeout(leaveTimerRef.current);
        if (!isControlled) {
          setInternalOpen(false);
        }
        onOpenChange?.(false);
      }
    }, [trigger, effectiveOpen, show, hide, isControlled, onOpenChange]);

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
    // Clone child element and attach event handlers
    const wrappedChildren = useMemo(() => {
      if (!isValidElement(children)) {
        return children;
      }

      const getElementProps = (
        element: React.ReactElement<TooltipChildProps>
      ): TooltipChildProps => {
        return element.props as TooltipChildProps;
      };

      const originalProps = getElementProps(
        children as React.ReactElement<TooltipChildProps>
      );

      // Preserve any ref the child already had (e.g. a parent's forwardRef
      // used for dropdown positioning). Without this, wrapping an element
      // in Tooltip would silently break refs like useDropdownEngine's
      // triggerRef, causing click-to-open dropdowns to never position. React's
      // refs rule conservatively treats cloneElement as a possible ref read;
      // this only forwards the callback for React to invoke during commit.
      // eslint-disable-next-line react-hooks/refs -- cloneElement forwards the composed callback ref; it never reads ref.current during render
      return cloneElement(children as React.ReactElement<TooltipChildProps>, {
        ref: triggerRef,
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
      effectiveOpen && positionReady && "native-tooltip-visible",
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

    const tooltipContent = effectiveOpen ? (
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

    const tooltipPortal = tooltipContent
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
