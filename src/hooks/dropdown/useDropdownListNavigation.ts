/**
 * useDropdownListNavigation Hook
 *
 * Adds keyboard navigation (ArrowUp/Down, Home/End, Enter) to any
 * dropdown built on `useDropdownEngine`. Mirrors the navigation contract
 * used by Spotlight's `useListNavigation` so dropdowns feel consistent
 * with the global palettes. Escape is intentionally NOT handled here
 * (the engine owns it).
 *
 * This hook is intentionally view-agnostic: callers own the items, the
 * panel markup, and the visual highlight. The hook provides:
 *
 *   - `selectedIndex` / `setSelectedIndex`: the highlighted row.
 *   - `getItemProps(index)`: spread on every row's button/div so the
 *     hook can drive hover-syncs-highlight, click-selects, and the
 *     `data-dropdown-item-index` attribute used for autoscroll.
 *   - `getPanelProps()`: spread on the dropdown panel root so the panel
 *     receives focus when opened (allowing key events to bubble up to
 *     the document listener while still working when the trigger lost
 *     focus, e.g. portal panels).
 *
 * Keyboard listener strategy:
 *   - A document-level `keydown` capture listener is registered while
 *     `isOpen` is `true`. This is the same pattern Spotlight uses and
 *     ensures keys are caught even when focus is on the trigger
 *     (clicked-open state) or somewhere outside the panel portal.
 *   - The listener bails on `event.isComposing` and when the target is a
 *     text-entry surface inside the panel (e.g. a search input wired
 *     separately). Search-input handlers can call `event.stopPropagation`
 *     to opt out of the global handler for specific keys.
 *
 * Escape behavior:
 *   - Escape is owned by `useDropdownEngine`'s own handler (`closeOnEsc`).
 *     This hook intentionally does NOT handle Escape, to keep ownership
 *     single. If you build a dropdown without the engine, install your
 *     own Escape handler.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ============================================
// Types
// ============================================

export interface UseDropdownListNavigationOptions<TItem> {
  /** Whether the dropdown is currently open. */
  isOpen: boolean;
  /** Item list. Items themselves are opaque to the hook. */
  items: readonly TItem[];
  /** Called when an item is committed via Enter or click. */
  onSelect: (item: TItem, index: number) => void;
  /**
   * Predicate to skip non-selectable rows (separators, headers, disabled
   * options). Defaults to "every row is selectable".
   */
  isItemSelectable?: (item: TItem, index: number) => boolean;
  /**
   * Initial selected index when the dropdown opens. Defaults to the
   * first selectable row. Pass `-1` to start with nothing highlighted
   * (mouse-first dropdowns).
   */
  initialSelectedIndex?: number;
  /**
   * When true and the initial row is highlighted visually, first ArrowDown
   * still lands on that row instead of advancing to the second row.
   */
  firstArrowDownSelectsInitial?: boolean;
  /**
   * Panel ref. When provided, the hook scrolls the matching
   * `[data-dropdown-item-index="N"]` into view as the highlight moves.
   */
  panelRef?: RefObject<HTMLElement | null>;
  /**
   * Disable the global capture listener. When `true`, callers must
   * forward key events themselves (e.g. via the returned
   * `handleKeyDown` on the panel). Default `false`.
   */
  disableGlobalListener?: boolean;
}

export interface UseDropdownListNavigationReturn {
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  /**
   * Spread on every row. Wires hover→highlight sync, click→select, the
   * `data-dropdown-item-index` attribute used for autoscroll, the
   * shared `data-dropdown-keyboard-highlight` attribute that paints the
   * keyboard-focused row (see global SCSS rule in `src/index.scss` —
   * same fill as the auto-discover keyboard path), and `aria-selected`
   * for accessibility.
   */
  getItemProps: (index: number) => {
    "data-dropdown-item-index": number;
    "data-dropdown-keyboard-highlight"?: "true";
    "data-dropdown-keyboard-mode"?: "true";
    "aria-selected": boolean;
    onMouseEnter: () => void;
    onClick: () => void;
  };
  /**
   * Spread on the panel root if you want a panel-scoped key handler
   * (useful when `disableGlobalListener` is true or when the panel is
   * focusable).
   */
  handleKeyDown: (event: ReactKeyboardEvent) => void;
  /** Whether the most recent highlight change came from keyboard. */
  keyboardNavigated: boolean;
  /** Switch back to pointer mode while preserving the current selected row. */
  clearKeyboardNavigation: () => void;
}

// ============================================
// Helpers
// ============================================

/**
 * Find the next selectable row.
 *
 * Behaviour:
 *   - `start < 0` (no current highlight): scan from the edge in `direction`
 *     and return the first selectable row, or `-1` if none.
 *   - `start >= 0`: scan from `start + direction` toward the edge in
 *     `direction` and return the first selectable row found, clamped to
 *     `start` when nothing further is selectable (so Arrow at the edge
 *     of the list is a no-op rather than wrapping or unhighlighting).
 *
 * Use `findSelectable(items, -1, 1, …)` for "first selectable from top"
 * and `findSelectable(items, -1, -1, …)` for "last selectable from bottom".
 */
function findSelectable<TItem>(
  items: readonly TItem[],
  start: number,
  direction: 1 | -1,
  isItemSelectable: (item: TItem, index: number) => boolean
): number {
  const count = items.length;
  if (count === 0) return -1;

  const fromEdge = start < 0;
  const scanStart = fromEdge
    ? direction === 1
      ? 0
      : count - 1
    : start + direction;

  for (
    let i = scanStart;
    direction === 1 ? i < count : i >= 0;
    i += direction
  ) {
    if (isItemSelectable(items[i], i)) return i;
  }
  return fromEdge ? -1 : start;
}

// ============================================
// Hook
// ============================================

export function useDropdownListNavigation<TItem>(
  options: UseDropdownListNavigationOptions<TItem>
): UseDropdownListNavigationReturn {
  const {
    isOpen,
    items,
    onSelect,
    isItemSelectable,
    initialSelectedIndex,
    firstArrowDownSelectsInitial = false,
    panelRef,
    disableGlobalListener = false,
  } = options;

  const selectableFn = useMemo(
    () => isItemSelectable ?? (() => true),
    [isItemSelectable]
  );

  // Default initial highlight = first selectable row.
  const computeInitial = useCallback((): number => {
    if (initialSelectedIndex !== undefined) return initialSelectedIndex;
    return findSelectable(items, -1, 1, selectableFn);
  }, [initialSelectedIndex, items, selectableFn]);

  const [selectedIndex, setSelectedIndex] = useState<number>(computeInitial);
  const [keyboardNavigated, setKeyboardNavigated] = useState(false);
  const keyboardNavigatedRef = useRef(false);
  const firstArrowDownSelectsInitialRef = useRef(firstArrowDownSelectsInitial);

  useEffect(() => {
    firstArrowDownSelectsInitialRef.current = firstArrowDownSelectsInitial;
  }, [firstArrowDownSelectsInitial]);

  // Reset highlight on the rising edge of `isOpen`. React's recommended
  // pattern for "adjusting state when a prop changes" is to compare against
  // the previously-rendered value held in state and dispatch a setter
  // during render — React re-renders the component before committing,
  // skipping the cascade that the React Compiler flags for set-state in
  // effects. See https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [prevOpen, setPrevOpen] = useState(isOpen);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      setSelectedIndex(computeInitial());
      setKeyboardNavigated(false);
    }
  }

  useEffect(() => {
    keyboardNavigatedRef.current = keyboardNavigated;
  }, [keyboardNavigated]);

  // Stable refs for the global listener so it doesn't reattach.
  const stateRef = useRef({ items, selectedIndex });
  useEffect(() => {
    stateRef.current = { items, selectedIndex };
  });

  const callbackRef = useRef({ onSelect, selectableFn });
  useEffect(() => {
    callbackRef.current = { onSelect, selectableFn };
  });

  // Autoscroll the highlighted row into view.
  useEffect(() => {
    if (!isOpen || selectedIndex < 0 || !panelRef?.current) return;
    const row = panelRef.current.querySelector<HTMLElement>(
      `[data-dropdown-item-index="${selectedIndex}"]`
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [isOpen, selectedIndex, panelRef]);

  // Shared core key handler used by both the global listener and the
  // panel-scoped `handleKeyDown`.
  const handleKeyCore = useCallback(
    (event: ReactKeyboardEvent | globalThis.KeyboardEvent): boolean => {
      const native: globalThis.KeyboardEvent =
        "nativeEvent" in event ? event.nativeEvent : event;
      if (native.isComposing) return false;
      // Footer checkboxes own their keys; Enter must not select a list row.
      if (
        event.target instanceof HTMLInputElement &&
        event.target.type === "checkbox"
      )
        return false;

      const { items: refItems, selectedIndex: refIndex } = stateRef.current;
      const { onSelect: refSelect, selectableFn: refSelectable } =
        callbackRef.current;

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          event.stopPropagation();
          const next =
            firstArrowDownSelectsInitialRef.current &&
            !keyboardNavigatedRef.current &&
            refIndex >= 0
              ? refIndex
              : findSelectable(refItems, refIndex, 1, refSelectable);
          if (next !== refIndex) {
            setSelectedIndex(next);
          }
          if (next >= 0) {
            keyboardNavigatedRef.current = true;
            setKeyboardNavigated(true);
          }
          return true;
        }
        case "ArrowUp": {
          event.preventDefault();
          event.stopPropagation();
          const next = findSelectable(refItems, refIndex, -1, refSelectable);
          if (next !== refIndex) {
            setSelectedIndex(next);
            keyboardNavigatedRef.current = true;
            setKeyboardNavigated(true);
          }
          return true;
        }
        case "Home": {
          event.preventDefault();
          event.stopPropagation();
          const next = findSelectable(refItems, -1, 1, refSelectable);
          if (next !== refIndex && next >= 0) {
            setSelectedIndex(next);
            keyboardNavigatedRef.current = true;
            setKeyboardNavigated(true);
          }
          return true;
        }
        case "End": {
          event.preventDefault();
          event.stopPropagation();
          const next = findSelectable(refItems, -1, -1, refSelectable);
          if (next !== refIndex && next >= 0) {
            setSelectedIndex(next);
            keyboardNavigatedRef.current = true;
            setKeyboardNavigated(true);
          }
          return true;
        }
        case "Enter": {
          event.preventDefault();
          event.stopPropagation();
          if (refIndex < 0 || refIndex >= refItems.length) return true;
          const item = refItems[refIndex];
          if (!refSelectable(item, refIndex)) return true;
          refSelect(item, refIndex);
          return true;
        }
      }
      return false;
    },
    []
  );

  // Global capture listener — active only while the dropdown is open.
  useEffect(() => {
    if (!isOpen || disableGlobalListener) return;

    const listener = (event: globalThis.KeyboardEvent) => {
      // Allow text inputs inside the panel (search boxes) to opt out
      // of the global handler by calling `event.stopPropagation()` on
      // their own listeners. We still handle keys when focus is on
      // the trigger or document body.
      handleKeyCore(event);
    };

    document.addEventListener("keydown", listener, true);
    return () => {
      document.removeEventListener("keydown", listener, true);
    };
  }, [isOpen, disableGlobalListener, handleKeyCore]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      handleKeyCore(event);
    },
    [handleKeyCore]
  );

  const clearKeyboardNavigation = useCallback(() => {
    keyboardNavigatedRef.current = false;
    setKeyboardNavigated(false);
  }, []);

  const getItemProps = useCallback(
    (index: number) => {
      const isHighlighted = index === selectedIndex;
      // Only paint the shared keyboard-highlight attribute when the
      // most recent highlight change came from a key — pointer hover
      // is already painted by the row's own `:hover` style, and we
      // don't want a stale keyboard fill lingering after the mouse
      // moves away. Mirrors `useDropdownAutoKeyboard`'s mousemove
      // clear so both keyboard paths feel identical.
      const props: {
        "data-dropdown-item-index": number;
        "data-dropdown-keyboard-highlight"?: "true";
        "data-dropdown-keyboard-mode"?: "true";
        "aria-selected": boolean;
        onMouseEnter: () => void;
        onClick: () => void;
      } = {
        "data-dropdown-item-index": index,
        "aria-selected": isHighlighted,
        onMouseEnter: () => {
          setSelectedIndex(index);
          clearKeyboardNavigation();
        },
        onClick: () => {
          const item = items[index];
          if (!item || !selectableFn(item, index)) return;
          onSelect(item, index);
        },
      };
      if (keyboardNavigated) {
        props["data-dropdown-keyboard-mode"] = "true";
      }
      if (isHighlighted && keyboardNavigated) {
        props["data-dropdown-keyboard-highlight"] = "true";
      }
      return props;
    },
    [
      items,
      selectableFn,
      onSelect,
      selectedIndex,
      keyboardNavigated,
      clearKeyboardNavigation,
    ]
  );

  return {
    selectedIndex,
    setSelectedIndex,
    getItemProps,
    handleKeyDown,
    keyboardNavigated,
    clearKeyboardNavigation,
  };
}

export default useDropdownListNavigation;
