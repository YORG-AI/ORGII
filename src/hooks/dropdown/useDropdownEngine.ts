/**
 * useDropdownEngine Hook
 *
 * Unified base hook for all dropdown behavior in the application.
 * Consolidates positioning, portal, click-outside, ESC, and scroll/resize
 * logic that was previously duplicated across older hooks and useSelect.
 *
 * This is the single source of truth for dropdown behavior.
 * Higher-level components (Dropdown, Select) and feature dropdowns
 * call this hook directly.
 */
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { useDropdownAutoKeyboard } from "./useDropdownAutoKeyboard";
import type {
  UseDropdownListNavigationOptions,
  UseDropdownListNavigationReturn,
} from "./useDropdownListNavigation";
import { useDropdownListNavigation } from "./useDropdownListNavigation";

// ============================================
// Types
// ============================================

export interface DropdownEnginePosition {
  top?: number;
  bottom?: number;
  left: number;
  right?: number;
  width: number;
  /**
   * Space left on the side the panel actually opened to, minus the gap and
   * viewport padding. Apply it as the panel's `max-height` so a list that
   * cannot fit scrolls instead of running off-screen.
   */
  maxHeight: number;
}

/**
 * List-navigation slice of the engine config. When `items` and
 * `onSelect` are provided, the engine wires Arrow/Home/End/Enter/Escape
 * navigation automatically and returns a `keyboard` object containing
 * the selected index and per-item prop getter.
 */
export interface DropdownEngineListNavigation<TItem> extends Omit<
  UseDropdownListNavigationOptions<TItem>,
  "isOpen" | "panelRef"
> {}

export interface UseDropdownEngineOptions<
  TItem = unknown,
  TTrigger extends HTMLElement = HTMLElement,
> {
  /** External anchor element for panel-only dropdowns whose trigger lives in a parent component. */
  anchorRef?: RefObject<TTrigger | null>;
  /** Initial open state (uncontrolled) */
  defaultOpen?: boolean;
  /** Controlled open state */
  open?: boolean;
  /** Called when open state changes */
  onOpenChange?: (open: boolean) => void;
  /** Prevents opening */
  disabled?: boolean;
  /** Gap between trigger and panel in px */
  gap?: number;
  /**
   * Where the panel appears relative to the trigger.
   * - "bottom": always below
   * - "top": always above
   * - "auto": flip based on available viewport space (default)
   */
  placement?: "bottom" | "top" | "auto";
  /** Horizontal alignment: "left" aligns panel left edge with trigger, "right" aligns right edges */
  align?: "left" | "right";
  /** Close on Escape key */
  closeOnEsc?: boolean;
  /** Close when clicking outside trigger and panel */
  closeOnClickOutside?: boolean;
  /**
   * Focus the panel once positioned so document-level Escape/arrow
   * listeners fire even when keyboard focus was parked in another pane.
   * Opt-in: hover-opened panels (tooltips) must never steal focus.
   */
  captureKeyboardFocus?: boolean;
  /** Additional portal roots that should be treated as part of this dropdown. */
  additionalInsideRefs?: ReadonlyArray<RefObject<HTMLElement | null>>;
  /**
   * Built-in keyboard list navigation. Pass `items` + `onSelect` to
   * enable Arrow/Home/End/Enter/Escape on the dropdown rows. The
   * resulting state is exposed as `keyboard` on the return value.
   *
   * Spread `keyboard.getItemProps(index)` on every row.
   */
  listNavigation?: DropdownEngineListNavigation<TItem>;
  /**
   * Zero-config keyboard navigation fallback. When `listNavigation` is
   * not provided, the engine installs a DOM-driven handler that
   * discovers focusable rows inside the panel (buttons, `[role="menuitem"]`,
   * `[role="option"]`) and drives Arrow/Home/End/Enter on them. Set
   * to `false` to disable (e.g. for triggers that own their own
   * keyboard logic, like `Select`'s `useDropdownKeyboard`). Default `true`.
   */
  autoKeyboardNavigation?: boolean;
}

export interface UseDropdownEngineReturn<
  TTrigger extends HTMLElement = HTMLDivElement,
> {
  isOpen: boolean;
  isPositioned: boolean;
  setIsOpen: (open: boolean) => void;
  toggle: () => void;
  close: () => void;
  triggerRef: RefObject<TTrigger | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  panelPosition: DropdownEnginePosition;
  updatePosition: () => void;
  /**
   * Keyboard navigation state. Always defined; when the caller did not
   * pass `listNavigation`, the object is wired to an empty item list
   * (Arrow keys become no-ops, Escape still closes the dropdown).
   */
  keyboard: UseDropdownListNavigationReturn;
}

// ============================================
// Hook
// ============================================

const DROPDOWN_EST_HEIGHT = 240;

/**
 * Position writes land on every scroll frame while a dropdown is open. The
 * numbers are usually identical (the trigger scrolled with its container),
 * so bail out before React re-renders every consumer of `panelPosition`.
 */
function isSamePosition(
  previous: DropdownEnginePosition,
  next: DropdownEnginePosition
): boolean {
  return (
    previous.top === next.top &&
    previous.bottom === next.bottom &&
    previous.left === next.left &&
    previous.right === next.right &&
    previous.width === next.width &&
    previous.maxHeight === next.maxHeight
  );
}

export function useDropdownEngine<
  TTrigger extends HTMLElement = HTMLDivElement,
  TItem = unknown,
>(
  options: UseDropdownEngineOptions<TItem, TTrigger> = {}
): UseDropdownEngineReturn<TTrigger> {
  const {
    anchorRef,
    defaultOpen = false,
    open: controlledOpen,
    onOpenChange,
    disabled = false,
    gap = DROPDOWN_PANEL.triggerGap,
    placement = "auto",
    align = "left",
    closeOnEsc = true,
    closeOnClickOutside = true,
    captureKeyboardFocus = false,
    additionalInsideRefs,
    listNavigation,
    autoKeyboardNavigation = true,
  } = options;

  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [isPositioned, setIsPositioned] = useState(false);
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const internalTriggerRef = useRef<TTrigger>(null!);
  const triggerRef = (anchorRef ?? internalTriggerRef) as RefObject<TTrigger>;
  const latestTriggerRef = useRef(triggerRef);
  useEffect(() => {
    latestTriggerRef.current = triggerRef;
  }, [triggerRef]);
  const panelRef = useRef<HTMLDivElement>(null!);
  const positionFrameRef = useRef<number | null>(null);
  const [panelPosition, setPanelPosition] = useState<DropdownEnginePosition>({
    left: 0,
    width: 0,
    maxHeight: DROPDOWN_PANEL.maxHeight,
  });

  // Participate in the global overlay-layer count so inline browser
  // WKWebViews drop behind React portals while this dropdown is open.
  useOverlayLayer(isOpen);

  const updatePosition = useCallback(() => {
    const triggerElement = latestTriggerRef.current.current;
    if (!triggerElement) return;

    const triggerRect = triggerElement.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    // One rect read serves both the flip decision and the horizontal clamp.
    // It is null on the first pass (panel not mounted yet); the follow-up
    // frame in the open effect re-runs with real measurements.
    const panelElement = panelRef.current;
    const panelRect = panelElement?.getBoundingClientRect();
    const panelWidth = panelRect?.width ?? 0;
    // `scrollHeight` reports the content height the panel *wants*, so the
    // flip decision is not fooled by the max-height a previous pass applied.
    const preferredHeight = panelElement
      ? Math.max(panelRect?.height ?? 0, panelElement.scrollHeight)
      : DROPDOWN_EST_HEIGHT;
    const padding = DROPDOWN_PANEL.viewportPadding;

    const spaceBelow = viewportHeight - triggerRect.bottom - gap - padding;
    const spaceAbove = triggerRect.top - gap - padding;

    let openAbove = placement === "top";
    if (placement === "auto") {
      if (preferredHeight <= spaceBelow) {
        openAbove = false;
      } else if (preferredHeight <= spaceAbove) {
        openAbove = true;
      } else {
        openAbove = spaceAbove > spaceBelow;
      }
    }

    const maxHeight = Math.max(
      DROPDOWN_PANEL.minAvailableHeight,
      Math.floor(openAbove ? spaceAbove : spaceBelow)
    );

    // Left-align to the trigger by default, but never let the panel run past
    // the viewport edge — clamping only kicks in once the panel is measured.
    let leftValue = triggerRect.left;
    let rightValue =
      align === "right" ? viewportWidth - triggerRect.right : undefined;

    if (panelWidth > 0) {
      const maxOffset = Math.max(padding, viewportWidth - padding - panelWidth);
      if (rightValue !== undefined) {
        rightValue = Math.min(Math.max(padding, rightValue), maxOffset);
      } else {
        leftValue = Math.min(Math.max(padding, leftValue), maxOffset);
      }
    }

    const nextPosition: DropdownEnginePosition = {
      ...(openAbove
        ? { bottom: viewportHeight - triggerRect.top + gap }
        : { top: triggerRect.bottom + gap }),
      left: leftValue,
      right: rightValue,
      width: triggerRect.width,
      maxHeight,
    };

    setPanelPosition((previous) =>
      isSamePosition(previous, nextPosition) ? previous : nextPosition
    );

    setIsPositioned(true);
  }, [gap, placement, align]);

  const schedulePositionUpdate = useCallback(() => {
    if (positionFrameRef.current !== null) return;

    positionFrameRef.current = window.requestAnimationFrame(() => {
      positionFrameRef.current = null;
      updatePosition();
    });
  }, [updatePosition]);

  useEffect(() => {
    return () => {
      if (positionFrameRef.current !== null) {
        window.cancelAnimationFrame(positionFrameRef.current);
        positionFrameRef.current = null;
      }
    };
  }, []);

  const setIsOpen = useCallback(
    (newOpen: boolean) => {
      if (disabled && newOpen) return;

      setIsPositioned(false);

      if (!isControlled) {
        setInternalOpen(newOpen);
      }
      onOpenChange?.(newOpen);
    },
    [isControlled, onOpenChange, disabled]
  );

  const toggle = useCallback(() => {
    const newOpen = !isOpen;
    if (newOpen) {
      updatePosition();
    }
    setIsOpen(newOpen);
  }, [isOpen, setIsOpen, updatePosition]);

  const close = useCallback(() => {
    setIsOpen(false);
  }, [setIsOpen]);

  useEffect(() => {
    if (isOpen) return;
    const id = requestAnimationFrame(() => setIsPositioned(false));
    return () => cancelAnimationFrame(id);
  }, [isOpen, setIsPositioned]);

  // Position when controlled open changes
  useEffect(() => {
    if (isOpen && !isPositioned) {
      updatePosition();
    }
  }, [isOpen, isPositioned, updatePosition]);

  // Re-position one frame after opening so actual panel height is available.
  useEffect(() => {
    if (!isOpen) return;

    const animationFrameId = window.requestAnimationFrame(() => {
      updatePosition();
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [isOpen, updatePosition]);

  // Scroll/resize listeners are frame-coalesced to avoid repeated layout reads
  // and React state writes when nested scroll containers emit in one frame.
  useEffect(() => {
    if (!isOpen) return;

    window.addEventListener("scroll", schedulePositionUpdate, true);
    window.addEventListener("resize", schedulePositionUpdate);

    return () => {
      window.removeEventListener("scroll", schedulePositionUpdate, true);
      window.removeEventListener("resize", schedulePositionUpdate);
      if (positionFrameRef.current !== null) {
        window.cancelAnimationFrame(positionFrameRef.current);
        positionFrameRef.current = null;
      }
    };
  }, [isOpen, schedulePositionUpdate]);

  // Re-position when trigger/panel dimensions change (search/filter/content updates).
  useEffect(() => {
    if (!isOpen || typeof ResizeObserver === "undefined") return;

    const panelElement = panelRef.current;
    const triggerElement = latestTriggerRef.current.current;
    if (!panelElement || !triggerElement) return;

    let animationFrameId: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = window.requestAnimationFrame(() => {
        updatePosition();
        animationFrameId = null;
      });
    });

    resizeObserver.observe(panelElement);
    resizeObserver.observe(triggerElement);

    return () => {
      resizeObserver.disconnect();
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isOpen, updatePosition]);

  // Click outside
  useEffect(() => {
    if (!isOpen || !closeOnClickOutside) return;

    const handlePointerDownOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const currentTrigger = latestTriggerRef.current.current;
      const outsideTrigger = currentTrigger && !currentTrigger.contains(target);
      const outsidePanel =
        panelRef.current && !panelRef.current.contains(target);
      const outsideAdditionalInsideRefs =
        additionalInsideRefs?.every(
          (insideRef) => !insideRef.current?.contains(target)
        ) ?? true;

      if (outsideTrigger && outsidePanel && outsideAdditionalInsideRefs) {
        setIsOpen(false);
      }
    };

    const timeoutId = window.setTimeout(() => {
      document.addEventListener("pointerdown", handlePointerDownOutside);
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("pointerdown", handlePointerDownOutside);
    };
  }, [isOpen, closeOnClickOutside, additionalInsideRefs, setIsOpen]);

  // Keyboard focus capture (opt-in): this document's keydown listeners only
  // fire if the view actually owns keyboard focus — with focus parked in
  // another pane (chat composer, embedded terminal) Escape never arrives.
  // Pull focus onto the panel once positioned, unless something inside it
  // (e.g. a search input's own autofocus, whose child effect ran first)
  // already took it. Opt-in because hover-opened panels (Tooltip) must
  // never steal focus from what the user is typing in.
  useEffect(() => {
    if (!isOpen || !isPositioned || !captureKeyboardFocus) return;
    const panelElement = panelRef.current;
    if (!panelElement) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelElement.contains(active)) return;
    panelElement.tabIndex = -1;
    panelElement.focus({ preventScroll: true });
  }, [isOpen, isPositioned, captureKeyboardFocus]);

  // ESC key
  useEffect(() => {
    if (!isOpen || !closeOnEsc) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeOnEsc, setIsOpen]);

  // List-navigation slice. The hook is always invoked (Hooks rule) but
  // becomes a near no-op when the caller did not pass `listNavigation`
  // (empty item list → Arrow keys do nothing). We force the global
  // capture listener OFF in that case so it doesn't preventDefault +
  // stopPropagation on ArrowDown/Enter and starve the DOM auto-discover
  // fallback below.
  const emptyItems = useMemo<readonly TItem[]>(() => [], []);
  const noopSelect = useCallback(() => undefined, []);
  const hasExplicitListNavigation = listNavigation !== undefined;
  const keyboard = useDropdownListNavigation<TItem>({
    isOpen,
    items: listNavigation?.items ?? emptyItems,
    onSelect: listNavigation?.onSelect ?? noopSelect,
    isItemSelectable: listNavigation?.isItemSelectable,
    initialSelectedIndex: listNavigation?.initialSelectedIndex,
    firstArrowDownSelectsInitial: listNavigation?.firstArrowDownSelectsInitial,
    panelRef,
    disableGlobalListener: hasExplicitListNavigation
      ? listNavigation?.disableGlobalListener
      : true,
  });

  // Auto-discover keyboard fallback. Only active when the caller did
  // NOT pass `listNavigation` (the explicit path wins) and did not
  // opt out via `autoKeyboardNavigation: false`. Lets every existing
  // dropdown built on the engine get Arrow/Enter/Home/End for free
  // without per-call-site wiring.
  useDropdownAutoKeyboard({
    isOpen,
    panelRef,
    onClose: close,
    enabled: autoKeyboardNavigation && !hasExplicitListNavigation,
  });

  return {
    isOpen,
    isPositioned,
    setIsOpen,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
    updatePosition,
    keyboard,
  };
}
