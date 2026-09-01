/**
 * Dropdown Component
 *
 * Unified dropdown with two usage modes:
 *
 * 1. **droplist mode** (existing) — pass arbitrary ReactNode as `droplist`
 * 2. **options mode** (new) — pass `options[]` for built-in rendering with
 *    search, keyboard navigation, multi-select, loading/empty states
 *
 * When `options` is provided, droplist is ignored.
 *
 * @example
 * ```tsx
 * // droplist mode (unchanged)
 * <Dropdown droplist={<Menu>...</Menu>} trigger="click" position="bottom">
 *   <button>Click me</button>
 * </Dropdown>
 *
 * // options mode (new)
 * <Dropdown
 *   options={[{ label: "One", value: 1 }, { label: "Two", value: 2 }]}
 *   value={selected}
 *   onSelect={(val) => setSelected(val)}
 *   showSearch
 * >
 *   <button>Pick one</button>
 * </Dropdown>
 * ```
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDropdownAutoKeyboard } from "@src/hooks/dropdown";
import { useMenuHoverGrace } from "@src/hooks/dropdown/useMenuHoverGrace";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";

import DropdownMenuSurface from "./DropdownMenuSurface";
import DropdownOptionsContent from "./DropdownOptionsContent";
import DropdownTriggerWrapper from "./DropdownTriggerWrapper";
import { defaultFilter, flattenOptions } from "./optionUtils";
import { subscribeToDropdownOutsideMouseDown } from "./outsideClick";
import {
  type DropdownCoordinates,
  type DropdownVerticalFit,
  areDropdownCoordinatesEqual,
  areVerticalFitsEqual,
  calculateDropdownPosition,
  resolveVerticalFit,
} from "./positioning";
import { DROPDOWN_PANEL } from "./tokens";
import type {
  DropdownOption,
  DropdownOptionGroup,
  DropdownPosition,
  DropdownSelectValue,
} from "./types";
import { useDropdownKeyboard } from "./useDropdownKeyboard";

export type { DropdownPosition } from "./types";

export interface DropdownProps {
  /** Dropdown content — arbitrary ReactNode. Ignored when `options` is provided. */
  droplist?: React.ReactNode;

  /** Trigger element */
  children: React.ReactElement;

  /**
   * Placement relative to the trigger. Vertical placements flip to their
   * mirror side automatically when the requested side cannot fit the panel.
   * @default 'bottom-end'
   */
  position?: DropdownPosition;

  /** @default 'click' */
  trigger?: "click" | "hover";

  /** Hover close delay in milliseconds (default 350). Set 0 for immediate close. */
  hoverCloseDelayMs?: number;

  /** Controlled visible state */
  popupVisible?: boolean;

  /** Default visible state */
  defaultPopupVisible?: boolean;

  /** Visibility change callback */
  onVisibleChange?: (visible: boolean) => void;

  /** Container for portal rendering */
  getPopupContainer?: () => HTMLElement;

  disabled?: boolean;

  /** Additional class name for dropdown panel */
  className?: string;

  /** Additional style for dropdown panel */
  style?: React.CSSProperties;

  /** Clamp portal dropdowns inside the viewport and flip horizontally when needed. */
  avoidViewportOverflow?: boolean;

  /**
   * Extra elements the outside-click close treats as inside the dropdown —
   * e.g. a second-level submenu panel portaled to `document.body`, which is
   * outside this panel's DOM but logically part of the open menu.
   */
  additionalInsideRefs?: ReadonlyArray<React.RefObject<HTMLElement | null>>;

  /** Option items. When provided, enables options mode (droplist is ignored). */
  options?: (DropdownOption | DropdownOptionGroup)[];

  /** Currently selected value(s) */
  value?: DropdownSelectValue;

  /** Called when an option is selected */
  onSelect?: (
    value: DropdownSelectValue,
    option: DropdownOption | DropdownOption[]
  ) => void;

  /** @default 'single' */
  mode?: "single" | "multiple";

  /** Show search input at top of options list */
  showSearch?: boolean;

  /** Placeholder text for the search input */
  searchPlaceholder?: string;

  /** Custom filter function for search */
  filterOption?: (inputValue: string, option: DropdownOption) => boolean;

  /** Show loading spinner instead of options */
  loading?: boolean;

  /** Custom empty state content */
  emptyContent?: React.ReactNode;

  /** Wraps the options content (for custom headers/footers) */
  dropdownRender?: (menu: React.ReactNode) => React.ReactNode;

  /** Enable keyboard navigation (default true when options provided) */
  keyboardNavigation?: boolean;

  /** Called when search value changes */
  onSearch?: (value: string) => void;
}

const Dropdown: React.FC<DropdownProps> = ({
  droplist,
  children,
  position = "bottom-end",
  trigger = "click",
  hoverCloseDelayMs,
  popupVisible: controlledVisible,
  defaultPopupVisible = false,
  onVisibleChange,
  getPopupContainer,
  disabled = false,
  className = "",
  style,
  avoidViewportOverflow = false,
  additionalInsideRefs,
  options: rawOptions,
  value,
  onSelect,
  mode = "single",
  showSearch = false,
  searchPlaceholder,
  filterOption,
  loading = false,
  emptyContent,
  dropdownRender,
  keyboardNavigation,
  onSearch,
}) => {
  const isOptionsMode = rawOptions !== undefined;
  const enableKeyboard = keyboardNavigation ?? isOptionsMode;

  const [internalVisible, setInternalVisible] = useState(defaultPopupVisible);
  const [searchValue, setSearchValue] = useState("");
  const [dropdownPosition, setDropdownPosition] =
    useState<DropdownCoordinates | null>(null);
  const [verticalFit, setVerticalFit] = useState<DropdownVerticalFit>({
    position,
    maxHeight: DROPDOWN_PANEL.maxHeight,
    constrained: false,
  });
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const positionFrameRef = useRef<number | null>(null);

  const isControlled = controlledVisible !== undefined;
  const visible = isControlled ? controlledVisible : internalVisible;
  const { cancel: cancelHover, schedule: scheduleHover } = useMenuHoverGrace(
    visible && trigger === "hover" && !disabled,
    hoverCloseDelayMs
  );

  useOverlayLayer(visible);

  const setVisible = useCallback(
    (newVisible: boolean) => {
      if (!newVisible) cancelHover();
      if (!isControlled) {
        setInternalVisible(newVisible);
      }
      onVisibleChange?.(newVisible);
    },
    [cancelHover, isControlled, onVisibleChange]
  );

  // Droplist mode parity with `useDropdownEngine`: discover button rows in
  // the panel subtree and drive Arrow/Home/End/Enter navigation. Options
  // mode runs its own typed keyboard handler (`useDropdownKeyboard`) below,
  // so we only enable the auto fallback for droplist mode.
  const autoKeyboardClose = useCallback(() => setVisible(false), [setVisible]);
  useDropdownAutoKeyboard({
    isOpen: visible && !isOptionsMode,
    panelRef: dropdownRef,
    onClose: autoKeyboardClose,
    enabled: !isOptionsMode,
  });

  const flatOptions = useMemo(
    () => (rawOptions ? flattenOptions(rawOptions) : []),
    [rawOptions]
  );

  const filteredOptions = useMemo(() => {
    if (!showSearch || !searchValue) return flatOptions;
    const filterFn = filterOption ?? defaultFilter;
    return flatOptions.filter((option) => filterFn(searchValue, option));
  }, [flatOptions, showSearch, searchValue, filterOption]);

  const handleOptionSelect = useCallback(
    (option: DropdownOption) => {
      if (option.disabled) return;

      if (mode === "multiple") {
        const values = Array.isArray(value) ? value : [];
        let newValue: (string | number)[];
        let newOptions: DropdownOption[];
        if (values.includes(option.value)) {
          newValue = values.filter((item) => item !== option.value);
          newOptions = flatOptions.filter((flatOption) =>
            newValue.includes(flatOption.value)
          );
        } else {
          newValue = [...values, option.value];
          newOptions = flatOptions.filter((flatOption) =>
            newValue.includes(flatOption.value)
          );
        }
        onSelect?.(newValue, newOptions);
      } else {
        onSelect?.(option.value, option);
        setVisible(false);
        setSearchValue("");
      }
    },
    [mode, value, flatOptions, onSelect, setVisible]
  );

  const {
    highlightedIndex,
    keyboardNavigated,
    handleKeyDown,
    resetHighlight,
    getOptionMouseEnterProps,
  } = useDropdownKeyboard({
    options: filteredOptions,
    isOpen: visible,
    onSelect: handleOptionSelect,
    onOpen: () => {
      if (!disabled) setVisible(true);
    },
    onClose: () => {
      setVisible(false);
      setSearchValue("");
    },
  });

  useEffect(() => {
    if (!visible || trigger !== "click") return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (additionalInsideRefs?.some((ref) => ref.current?.contains(target))) {
        return;
      }
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setVisible(false);
        if (isOptionsMode) {
          setSearchValue("");
          resetHighlight();
        }
      }
    };

    return subscribeToDropdownOutsideMouseDown(document, handleClickOutside);
  }, [
    visible,
    trigger,
    setVisible,
    isOptionsMode,
    resetHighlight,
    additionalInsideRefs,
  ]);

  const handleMouseEnter = useCallback(() => {
    if (trigger === "hover" && !disabled) {
      cancelHover();
      setVisible(true);
    }
  }, [trigger, disabled, setVisible, cancelHover]);

  const handleMouseLeave = useCallback(() => {
    if (trigger !== "hover") return;

    scheduleHover(() => setVisible(false));
  }, [trigger, scheduleHover, setVisible]);

  const updatePosition = useCallback(() => {
    const triggerElement = triggerRef.current;
    if (!triggerElement) return;

    // Flip decision first: the portal branch needs the resolved side to
    // compute its coordinates, and the in-flow branch needs it to pick
    // its Tailwind placement classes.
    const nextFit = resolveVerticalFit({
      position,
      triggerElement,
      panelElement: dropdownRef.current,
    });
    setVerticalFit((previous) =>
      areVerticalFitsEqual(previous, nextFit) ? previous : nextFit
    );

    if (!getPopupContainer) return;

    // End-aligned panels are placed from their own width, so measuring before
    // the panel is in the DOM resolves to a start-aligned coordinate. The
    // panel stays hidden until a pass can measure it, otherwise it paints on
    // the wrong edge and visibly jumps across once the real width arrives.
    if (!dropdownRef.current) return;

    const nextCoordinates = calculateDropdownPosition({
      position: nextFit.position,
      triggerElement,
      containerElement: getPopupContainer(),
      dropdownElement: dropdownRef.current,
      avoidViewportOverflow,
    });
    setDropdownPosition((previous) =>
      areDropdownCoordinatesEqual(previous, nextCoordinates)
        ? previous
        : nextCoordinates
    );
  }, [avoidViewportOverflow, position, getPopupContainer]);

  // Scroll and resize can both fire many times per frame; collapse them into
  // a single measurement so an open dropdown costs one layout read per frame
  // instead of one per event.
  const schedulePositionUpdate = useCallback(() => {
    if (positionFrameRef.current !== null) return;
    positionFrameRef.current = window.requestAnimationFrame(() => {
      positionFrameRef.current = null;
      updatePosition();
    });
  }, [updatePosition]);

  useEffect(() => {
    if (!visible) return;

    queueMicrotask(() => updatePosition());
    const animationFrameId = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", schedulePositionUpdate);
    // Only portal panels are pinned to viewport coordinates and must track
    // scrolling. In-flow panels move with their trigger, so they settle for
    // the two passes above plus resize — no capture-phase scroll listener.
    if (getPopupContainer) {
      window.addEventListener("scroll", schedulePositionUpdate, true);
    }

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", schedulePositionUpdate);
      if (getPopupContainer) {
        window.removeEventListener("scroll", schedulePositionUpdate, true);
      }
      if (positionFrameRef.current !== null) {
        window.cancelAnimationFrame(positionFrameRef.current);
        positionFrameRef.current = null;
      }
    };
  }, [visible, updatePosition, schedulePositionUpdate, getPopupContainer]);

  useEffect(() => {
    if (visible) return;
    const id = requestAnimationFrame(() => {
      setDropdownPosition(null);
      // Drop back to the requested side so the next open never flashes on
      // the side the previous one happened to flip to.
      setVerticalFit({
        position,
        maxHeight: DROPDOWN_PANEL.maxHeight,
        constrained: false,
      });
    });
    return () => cancelAnimationFrame(id);
  }, [visible, position]);

  useEffect(() => {
    if (visible && isOptionsMode && showSearch) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 10);
      return () => clearTimeout(timer);
    }
  }, [visible, isOptionsMode, showSearch]);

  const handleTriggerClick = useCallback(() => {
    if (trigger === "click" && !disabled) {
      setVisible(!visible);
    }
  }, [trigger, disabled, visible, setVisible]);

  const handleSearchChange = useCallback(
    (newSearchValue: string) => {
      setSearchValue(newSearchValue);
      resetHighlight();
      onSearch?.(newSearchValue);
    },
    [resetHighlight, onSearch]
  );

  const panelContent = isOptionsMode ? (
    <DropdownOptionsContent
      showSearch={showSearch}
      searchPlaceholder={searchPlaceholder}
      searchValue={searchValue}
      onSearchChange={handleSearchChange}
      searchInputRef={searchInputRef}
      filteredOptions={filteredOptions}
      value={value}
      mode={mode}
      highlightedIndex={highlightedIndex}
      keyboardNavigated={keyboardNavigated}
      onSelect={handleOptionSelect}
      getOptionMouseEnterProps={getOptionMouseEnterProps}
      loading={loading}
      emptyContent={emptyContent}
      dropdownRender={dropdownRender}
    />
  ) : (
    droplist
  );

  return (
    <DropdownTriggerWrapper
      triggerRef={triggerRef}
      disabled={disabled}
      enableKeyboard={enableKeyboard}
      onClick={handleTriggerClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={trigger === "hover" ? handleMouseEnter : undefined}
      onMouseLeave={trigger === "hover" ? handleMouseLeave : undefined}
    >
      {children}
      <DropdownMenuSurface
        visible={visible}
        getPopupContainer={getPopupContainer}
        dropdownRef={dropdownRef}
        position={verticalFit.position}
        maxHeight={verticalFit.constrained ? verticalFit.maxHeight : undefined}
        className={className}
        style={style}
        dropdownPosition={dropdownPosition}
        trigger={trigger}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {panelContent}
      </DropdownMenuSurface>
    </DropdownTriggerWrapper>
  );
};

export default Dropdown;
