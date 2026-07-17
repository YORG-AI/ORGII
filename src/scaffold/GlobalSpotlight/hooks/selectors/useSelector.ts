/**
 * useSelector Base Hook
 *
 * Shared state management and effects for all selector components.
 * Consolidates common patterns: state, open/close effects, keyboard handling.
 *
 * @example
 * const {
 *   searchQuery, setSearchQuery,
 *   selectedIndex, setSelectedIndex,
 *   inputRef, handleKeyDown, handleItemClick
 * } = useSelector({ isOpen, onClose, items });
 */
import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useListNavigation } from "@src/hooks/keyboard";

import type { SpotlightItem } from "../../types";

// ============ TYPES ============

/**
 * Options for the selector kernel hook.
 *
 * The kernel owns core state (internal search query, selected index, input
 * ref) and keyboard navigation by default. Palettes that need their own
 * query state or custom key handling can supply the `external*` fields; in
 * that case the kernel becomes a thin composition layer on top of
 * caller-owned state/handlers, so palettes don't need to wrap the returned
 * kernel in a `useMemo` shim.
 */
export interface UseSelectorOptions {
  /** Whether the selector is open */
  isOpen: boolean;
  /** Callback to close the selector */
  onClose: () => void;
  /** Items to navigate through */
  items: SpotlightItem[];
  /** Whether in a modal/sub-view state (for escape handling) */
  hasModalState?: boolean;
  /** Handler to go back from modal state */
  onGoBack?: () => void;
  /** Determine whether an item is selectable (e.g., skip headers) */
  isItemSelectable?: (item: SpotlightItem) => boolean;
  /** Initial selected index (default: 0, first item pre-selected) */
  initialSelectedIndex?: number;
  /** Additional state to reset on open (will be called in effect) */
  onReset?: () => void;
  /**
   * External search query managed by the caller.
   * When provided, useListNavigation uses this instead of the internal
   * searchQuery for Backspace handling (only trigger onGoBack when empty).
   * The internal searchQuery still exists for callers that don't manage their own.
   */
  externalSearchQuery?: string;
  /**
   * External setter for the search query. When provided, the returned
   * `kernel.setSearchQuery` forwards to this setter instead of writing to
   * the kernel's internal state, and additionally resets `selectedIndex`
   * to the first selectable item. Use this when the palette owns its own
   * `useState` for the query (e.g. WorkspacePalette, DatabasePalette) so they
   * don't need to wrap the kernel in a `useMemo` shim.
   *
   * Typically paired with `externalSearchQuery` so the kernel's Backspace
   * / goBack logic and the caller's setter stay in sync.
   */
  externalSetSearchQuery?: (value: string) => void;
  /**
   * External keyboard handler. When provided, the returned
   * `kernel.handleKeyDown` delegates to this function instead of invoking
   * the kernel's internal handler directly.
   *
   * The external handler receives the original keyboard event plus a
   * reference to the kernel's internal `handleKeyDown`, so the palette
   * can choose to:
   *   - handle the event fully (do nothing with the internal handler), or
   *   - fall through to the kernel default by calling
   *     `internalHandleKeyDown(event)` itself.
   *
   * This matches patterns like DatabasePalette's "path mode" where custom
   * handling runs first and the kernel handler is invoked only in the
   * default branch.
   */
  externalHandleKeyDown?: (
    event: KeyboardEvent<HTMLInputElement>,
    internalHandleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  ) => void;
  /** Optional Tab handler for palettes with multiple navigable sections. */
  onTab?: (
    forward: boolean,
    selectedIndex: number,
    setSelectedIndex: Dispatch<SetStateAction<number>>
  ) => void;
  /** Called before a selectable item runs its action, for entry-state tracking. */
  onActivateItem?: (item: SpotlightItem, index: number) => void;
  /**
   * External item-click handler. When provided, the returned
   * `kernel.handleItemClick` forwards to this handler instead of invoking
   * `item.action?.()` directly. Use when the palette routes item clicks
   * through its own dispatcher (e.g. EditorPalette's mode-aware handler).
   */
  externalHandleItemClick?: (item: SpotlightItem) => void;
}

export interface UseSelectorReturn {
  /** Current search query */
  searchQuery: string;
  /** Set search query (also resets selectedIndex to 0) */
  setSearchQuery: (query: string) => void;
  /** Raw setter for search query without resetting index */
  setSearchQueryRaw: Dispatch<SetStateAction<string>>;
  /** Currently selected item index */
  selectedIndex: number;
  /** Set selected index */
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  /** Input ref for auto-focus */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Keyboard event handler for input */
  handleKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Click handler for items */
  handleItemClick: (item: SpotlightItem) => void;
  /** Focus the input element */
  focusInput: () => void;
  /** Find the first selectable item index (skips headers) */
  findFirstSelectable: () => number;
}

// ============ HOOK IMPLEMENTATION ============

/**
 * Base hook for selector components.
 * Provides unified state management, keyboard handling, and open/close effects.
 */
export function useSelector(options: UseSelectorOptions): UseSelectorReturn {
  const {
    isOpen,
    onClose,
    items,
    hasModalState = false,
    onGoBack,
    isItemSelectable,
    initialSelectedIndex = 0,
    onReset,
    externalSearchQuery,
    externalSetSearchQuery,
    externalHandleKeyDown,
    onTab,
    onActivateItem,
    externalHandleItemClick,
  } = options;

  // ============ STATE ============
  const [searchQuery, setSearchQueryState] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
  const inputRef = useRef<HTMLInputElement>(null);

  // Store refs to avoid stale closures
  const onResetRef = useRef(onReset);
  useEffect(() => {
    onResetRef.current = onReset;
  });

  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  const isItemSelectableRef = useRef(isItemSelectable);
  useEffect(() => {
    isItemSelectableRef.current = isItemSelectable;
  });

  // Track if we've already initialized for this "open" session
  const hasInitializedRef = useRef(false);

  // ============ HELPERS ============

  /** Find the first selectable item index (skips headers) */
  const findFirstSelectable = useCallback(() => {
    const currentItems = itemsRef.current;
    const checker = isItemSelectableRef.current;
    if (!checker) return 0;
    for (let idx = 0; idx < currentItems.length; idx++) {
      if (checker(currentItems[idx])) return idx;
    }
    return 0;
  }, []);

  const focusInput = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // ============ EFFECTS ============

  // Reset state and focus input on open (only when transitioning from closed to open)
  useEffect(() => {
    if (isOpen && !hasInitializedRef.current) {
      hasInitializedRef.current = true;

      Promise.resolve().then(() => {
        setSearchQueryState("");
        setSelectedIndex(findFirstSelectable());
        onResetRef.current?.();
      });

      // Focus input after state reset
      setTimeout(() => inputRef.current?.focus(), 50);
    } else if (!isOpen) {
      // Reset flag when closed so next open triggers reset
      hasInitializedRef.current = false;
    }
  }, [isOpen, findFirstSelectable]);

  // ============ KEYBOARD HANDLING ============

  // Effective search query: prefer external (caller-managed) over internal
  const effectiveSearchQuery = externalSearchQuery ?? searchQuery;

  // Refocus input after any sub-level navigation. The path template may
  // change (unmounting/remounting the input), so we must refocus after
  // the DOM commits. We track a counter that increments on every goBack,
  // and refocus in an effect.
  const [focusTick, setFocusTick] = useState(0);

  // Wrap onGoBack to trigger refocus after the transition
  const wrappedOnGoBack = useCallback(() => {
    onGoBack?.();
    setFocusTick((tick) => tick + 1);
  }, [onGoBack]);

  // Reset selectedIndex only when list content changes (not just array
  // reference churn from re-renders), matching spotlight reducer behavior.
  const itemsIdentityKey = useMemo(
    () => items.map((item) => item.id).join("|"),
    [items]
  );
  const prevItemsIdentityRef = useRef(itemsIdentityKey);
  useEffect(() => {
    if (prevItemsIdentityRef.current !== itemsIdentityKey) {
      prevItemsIdentityRef.current = itemsIdentityKey;
      Promise.resolve().then(() => {
        setSelectedIndex(findFirstSelectable());
      });
    }
  }, [itemsIdentityKey, findFirstSelectable]);

  // Refocus input after DOM commits when the view changes. Two guards keep
  // this from becoming a focus-steal loop (it once pegged the webview at
  // ~90% CPU on the session-starter page):
  //  - never run while closed — a closed palette must not steal focus from
  //    the composer (the steal triggers re-renders that re-fire this effect);
  //  - key on the items' CONTENT identity, not the array reference, which
  //    changes on every parent render.
  useEffect(() => {
    if (!isOpen) return;
    focusInput();
  }, [focusTick, itemsIdentityKey, isOpen, focusInput]);

  // Unified keyboard navigation with global listener support
  const { handleKeyDown: internalHandleKeyDown } = useListNavigation({
    items: items as unknown as Array<{
      action?: () => void;
      [key: string]: unknown;
    }>,
    selectedIndex,
    onSelectedIndexChange: setSelectedIndex,
    onSelect: (item, index) => {
      const spotlightItem = item as unknown as SpotlightItem;
      onActivateItem?.(spotlightItem, index);
      spotlightItem.action?.();
    },
    onClose,
    onTab: onTab
      ? (forward) => onTab(forward, selectedIndex, setSelectedIndex)
      : undefined,
    onGoBack: wrappedOnGoBack,
    isItemSelectable:
      isItemSelectable &&
      ((item, _index) => isItemSelectable(item as unknown as SpotlightItem)),
    searchQuery: effectiveSearchQuery,
    enableGlobalListener: true,
    inputRef,
    hasModalState,
  });

  // ============ HANDLERS ============

  // Delegate to an external keyboard handler when supplied; otherwise run
  // the kernel's internal handler. The external handler receives the
  // internal handler so callers can fall through to it when appropriate.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (externalHandleKeyDown) {
        externalHandleKeyDown(event, internalHandleKeyDown);
        return;
      }
      internalHandleKeyDown(event);
    },
    [externalHandleKeyDown, internalHandleKeyDown]
  );

  // Set search query and reset selected index to first selectable item.
  // When an external setter is supplied, forward to it instead of writing
  // to internal state (the caller owns the query).
  const setSearchQuery = useCallback(
    (query: string) => {
      if (externalSetSearchQuery) {
        externalSetSearchQuery(query);
        setSelectedIndex(findFirstSelectable());
        return;
      }
      setSearchQueryState(query);
      setSelectedIndex(findFirstSelectable());
    },
    [externalSetSearchQuery, findFirstSelectable]
  );

  // Item click handler. When an external handler is supplied, delegate to
  // it so the palette can route clicks through its own dispatcher.
  const handleItemClick = useCallback(
    (item: SpotlightItem) => {
      onActivateItem?.(item, selectedIndex);
      if (externalHandleItemClick) {
        externalHandleItemClick(item);
        return;
      }
      item.action?.();
    },
    [externalHandleItemClick, onActivateItem, selectedIndex]
  );

  // ============ RETURN ============

  // `searchQuery` should reflect the effective value the kernel is
  // operating on — if the caller supplied an external source, surface it
  // so PaletteBody renders the right string without the caller having to
  // pass a parallel prop.
  return {
    searchQuery: effectiveSearchQuery,
    setSearchQuery,
    setSearchQueryRaw: setSearchQueryState,
    selectedIndex,
    setSelectedIndex,
    inputRef,
    handleKeyDown,
    handleItemClick,
    focusInput,
    findFirstSelectable,
  };
}
