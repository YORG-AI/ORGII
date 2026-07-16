/**
 * UnifiedModelDropdown Component
 *
 * Compact, anchored variant of UnifiedModelPalette. Renders the same
 * model / source selection flow produced by `useUnifiedModelPalette`,
 * but as a small dropdown attached to a trigger element instead of the
 * full-screen Spotlight overlay.
 *
 * The two variants share business logic — only the chrome differs. The
 * active variant is chosen by the `general.modelPickerStyle` setting and
 * dispatched in `ModelPill`.
 */
import { Check, ChevronRight, Search } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import HoverSafeSubmenuBridge from "@src/components/Dropdown/HoverSafeSubmenuBridge";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import {
  type UseDropdownListNavigationReturn,
  useDropdownEngine,
} from "@src/hooks/dropdown";
import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import { useFilteredItems } from "@src/hooks/search";
import { getViewportSize } from "@src/util/ui/window/viewport";

import type { SpotlightItem } from "../../shared";
import type { UnifiedModelPaletteProps } from "./types";
import {
  MODEL_SECTION,
  useUnifiedModelPalette,
} from "./useUnifiedModelPalette";

const DROPDOWN_WIDTH = 380;
const SUBMENU_WIDTH = 260;
const SUBMENU_GAP = DROPDOWN_PANEL.submenuGap;
const SUBMENU_VERTICAL_OFFSET = 4;
const LIST_MAX_HEIGHT = 280;
const VIEWPORT_MARGIN = 12;
const SIDE_PANEL_ANCHOR_CHANGE_EVENT = "dropdown-side-panel-anchor-change";
const MODEL_PROPERTIES_CLOSE_EVENT = "model-properties-dropdown-close";

function getItemData(item: SpotlightItem): Record<string, unknown> {
  return (item.data as Record<string, unknown> | undefined) ?? {};
}

function isHeaderItem(item: SpotlightItem): boolean {
  return getItemData(item).isHeader === true;
}

type SubmenuSide = "left" | "right";

interface DropdownRowProps {
  item: SpotlightItem;
  keyboardProps?: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
  onItemMouseEnter?: (element: HTMLElement) => void;
  onRowMouseEnter?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  submenuSide?: SubmenuSide;
}

const DropdownRow: React.FC<DropdownRowProps> = ({
  item,
  keyboardProps,
  onItemMouseEnter,
  onRowMouseEnter,
  submenuSide,
}) => {
  const data = getItemData(item);
  const isCurrent = data.isCurrentSelection === true;

  const renderedIcon = useMemo(() => {
    if (isCurrent) {
      return (
        <Check
          size={DROPDOWN_ITEM.iconSize}
          strokeWidth={2.25}
          className="text-primary-6"
        />
      );
    }
    if (!item.icon) return null;
    if (typeof item.icon === "string") {
      return <i className={`${item.icon} text-[14px] text-text-2`} />;
    }
    return React.createElement(item.icon, {
      size: 14,
      className: "text-text-2",
    });
  }, [item.icon, isCurrent]);

  if (isHeaderItem(item)) {
    return (
      <div
        className={DROPDOWN_CLASSES.sectionLabel}
        onMouseEnter={(event) => onItemMouseEnter?.(event.currentTarget)}
      >
        {item.label}
      </div>
    );
  }

  const labelContent = data.labelContent as React.ReactNode | undefined;
  const rightContent = data.rightContent as React.ReactNode | undefined;
  const rightLabel = data.rightLabel as string | undefined;
  const testId = typeof data.testId === "string" ? data.testId : undefined;
  const handleMouseEnter = (event: React.MouseEvent<HTMLButtonElement>) => {
    keyboardProps?.onMouseEnter();
    onItemMouseEnter?.(event.currentTarget);
    onRowMouseEnter?.(event);
  };

  return (
    <button
      type="button"
      data-dropdown-model-row-anchor
      data-testid={testId}
      {...keyboardProps}
      onMouseEnter={handleMouseEnter}
      className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} group/model-row w-full justify-start [&_button]:!font-normal [&_span]:!font-normal`}
    >
      {renderedIcon && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-1">
          {renderedIcon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden truncate text-[13px]">
        {labelContent ?? item.label}
      </span>
      {rightContent ? (
        <span className="relative z-10 ml-1 flex shrink-0 items-center">
          {rightContent}
        </span>
      ) : (
        rightLabel && (
          <span className="relative z-10 ml-1 shrink-0 truncate text-[12px] text-text-3">
            {rightLabel}
          </span>
        )
      )}
      {submenuSide && (
        <ChevronRight
          size={DROPDOWN_ITEM.iconSize}
          className="shrink-0 text-text-3"
        />
      )}
    </button>
  );
};

export interface UnifiedModelDropdownProps extends UnifiedModelPaletteProps {
  /** Element the dropdown is anchored to. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Preferred vertical placement. Defaults to opening below the trigger. */
  placement?: "bottom" | "top";
}

export const UnifiedModelDropdown: React.FC<UnifiedModelDropdownProps> = ({
  isOpen,
  onClose,
  advancedConfig,
  onConfigChange,
  dispatchCategoryOverride,
  cliAgentTypeOverride,
  anchorRef,
  placement = "bottom",
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const tauriSelectAll = useTauriSelectAllShortcut();

  const {
    recentItems,
    recentHeader,
    allModelItems,
    allHeader,
    sourceItems,
    selectedModelId,
    tCommon,
  } = useUnifiedModelPalette({
    isOpen,
    onClose,
    advancedConfig,
    onConfigChange,
    dispatchCategoryOverride,
    cliAgentTypeOverride,
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuSelectedIndex, setSubmenuSelectedIndex] = useState(0);
  const [submenuAnchorTop, setSubmenuAnchorTop] = useState<number | null>(null);
  const [primaryPanelMetrics, setPrimaryPanelMetrics] = useState<{
    top: number;
    height: number;
  } | null>(null);
  const notifySidePanelAnchorChange = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event(SIDE_PANEL_ANCHOR_CHANGE_EVENT));
    });
  }, []);
  const closeModelPropertiesDropdown = useCallback(
    (hoveredElement: HTMLElement) => {
      window.dispatchEvent(
        new CustomEvent(MODEL_PROPERTIES_CLOSE_EVENT, {
          detail: { hoveredElement },
        })
      );
    },
    []
  );

  const getSearchText = useCallback((item: SpotlightItem) => {
    const data = getItemData(item);
    const rightLabel = (data.rightLabel as string | undefined) ?? "";
    const searchAlias = (data.searchAlias as string | undefined) ?? "";
    return `${item.label} ${item.desc || ""} ${rightLabel} ${searchAlias}`;
  }, []);

  const { filteredItems: filteredRecentItems } = useFilteredItems({
    items: recentItems,
    searchQuery,
    getSearchText,
  });
  const { filteredItems: filteredAllModelItems } = useFilteredItems({
    items: allModelItems,
    searchQuery,
    getSearchText,
  });
  const filteredItems = useMemo((): SpotlightItem[] => {
    const items: SpotlightItem[] = [];
    if (filteredRecentItems.length > 0) {
      items.push(recentHeader, ...filteredRecentItems);
    }
    if (filteredAllModelItems.length > 0) {
      items.push(allHeader, ...filteredAllModelItems);
    }
    return items;
  }, [filteredRecentItems, recentHeader, filteredAllModelItems, allHeader]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      setSearchQuery("");
      setSubmenuOpen(false);
      setSubmenuSelectedIndex(0);
      setSubmenuAnchorTop(null);
      setPrimaryPanelMetrics(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const itemUsesSourceSubmenu = useCallback((item: SpotlightItem) => {
    return getItemData(item).modelSection === MODEL_SECTION.ALL;
  }, []);

  const openSourcesForItem = useCallback(
    (item: SpotlightItem, anchorTop?: number) => {
      if (isHeaderItem(item) || !itemUsesSourceSubmenu(item)) return;
      item.action?.();
      setSubmenuOpen(true);
      setSubmenuSelectedIndex(0);
      if (anchorTop !== undefined) setSubmenuAnchorTop(anchorTop);
      notifySidePanelAnchorChange();
    },
    [itemUsesSourceSubmenu, notifySidePanelAnchorChange]
  );

  const handleSelect = useCallback(
    (item: SpotlightItem) => {
      if (isHeaderItem(item)) return;
      if (itemUsesSourceSubmenu(item)) {
        openSourcesForItem(item);
        return;
      }
      item.action?.();
    },
    [itemUsesSourceSubmenu, openSourcesForItem]
  );

  const { isPositioned, panelRef, panelPosition, keyboard } = useDropdownEngine<
    HTMLElement,
    SpotlightItem
  >({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    anchorRef,
    placement,
    gap: DROPDOWN_PANEL.triggerGap,
    closeOnEsc: false,
    listNavigation: {
      items: filteredItems,
      onSelect: handleSelect,
      isItemSelectable: (item) => !isHeaderItem(item),
      initialSelectedIndex: -1,
    },
  });

  useEffect(() => {
    if (!isOpen || !isPositioned) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, isPositioned]);

  const effectiveSubmenuOpen =
    submenuOpen && Boolean(selectedModelId) && sourceItems.length > 0;

  useEffect(() => {
    if (!effectiveSubmenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPrimaryPanelMetrics({ top: rect.top, height: rect.height });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [effectiveSubmenuOpen, filteredItems.length, panelRef]);

  const effectiveSubmenuSelectedIndex = Math.min(
    submenuSelectedIndex,
    Math.max(sourceItems.length - 1, 0)
  );

  const selectSubmenuSource = useCallback(
    (index: number) => {
      const sourceItem = sourceItems[index];
      if (!sourceItem) return;
      sourceItem.action?.();
    },
    [sourceItems]
  );

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (effectiveSubmenuOpen) {
          setSubmenuOpen(false);
          return;
        }
        onClose();
        return;
      }

      if (effectiveSubmenuOpen) {
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            setSubmenuSelectedIndex((prev) =>
              Math.min(prev + 1, Math.max(sourceItems.length - 1, 0))
            );
            return;
          case "ArrowUp":
            event.preventDefault();
            setSubmenuSelectedIndex((prev) => Math.max(prev - 1, 0));
            return;
          case "ArrowLeft":
            event.preventDefault();
            setSubmenuOpen(false);
            return;
          case "Enter":
            event.preventDefault();
            selectSubmenuSource(effectiveSubmenuSelectedIndex);
            return;
          default:
            return;
        }
      }

      if (event.key === "ArrowRight" || event.key === "Tab") {
        const selectedItem = filteredItems[keyboard.selectedIndex];
        if (
          selectedItem &&
          !isHeaderItem(selectedItem) &&
          itemUsesSourceSubmenu(selectedItem)
        ) {
          event.preventDefault();
          const selectedElement = panelRef.current?.querySelector<HTMLElement>(
            `[data-dropdown-item-index="${keyboard.selectedIndex}"]`
          );
          openSourcesForItem(
            selectedItem,
            selectedElement?.getBoundingClientRect().top
          );
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [
    isOpen,
    effectiveSubmenuOpen,
    effectiveSubmenuSelectedIndex,
    sourceItems.length,
    filteredItems,
    keyboard.selectedIndex,
    openSourcesForItem,
    itemUsesSourceSubmenu,
    onClose,
    panelRef,
    selectSubmenuSource,
  ]);

  const placeholder = tCommon("filters.searchModel");

  if (!isOpen || !isPositioned) return null;

  const { width: vw, height: vh } = getViewportSize();
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(panelPosition.left, vw - VIEWPORT_MARGIN - DROPDOWN_WIDTH)
  );
  const rightSubmenuLeft = left + DROPDOWN_WIDTH + SUBMENU_GAP;
  const leftSubmenuLeft = left - SUBMENU_GAP - SUBMENU_WIDTH;
  const canOpenSubmenuRight =
    rightSubmenuLeft + SUBMENU_WIDTH <= vw - VIEWPORT_MARGIN;
  const canOpenSubmenuLeft = leftSubmenuLeft >= VIEWPORT_MARGIN;
  const rightAvailableWidth = vw - rightSubmenuLeft - VIEWPORT_MARGIN;
  const leftAvailableWidth = left - SUBMENU_GAP - VIEWPORT_MARGIN;
  const submenuSide: SubmenuSide =
    canOpenSubmenuRight ||
    (!canOpenSubmenuLeft && rightAvailableWidth >= leftAvailableWidth)
      ? "right"
      : "left";
  const submenuLeft = Math.max(
    VIEWPORT_MARGIN,
    Math.min(
      submenuSide === "right" ? rightSubmenuLeft : leftSubmenuLeft,
      vw - VIEWPORT_MARGIN - SUBMENU_WIDTH
    )
  );
  const submenuEstimatedHeight = Math.min(
    LIST_MAX_HEIGHT + 36,
    sourceItems.length * 34 + 36
  );
  const fallbackSubmenuTop = panelPosition.top ?? VIEWPORT_MARGIN;
  const preferredSubmenuTop =
    (submenuAnchorTop ?? fallbackSubmenuTop) - SUBMENU_VERTICAL_OFFSET;
  const submenuTop = Math.max(
    VIEWPORT_MARGIN,
    Math.min(preferredSubmenuTop, vh - VIEWPORT_MARGIN - submenuEstimatedHeight)
  );
  const primaryPanelTop =
    primaryPanelMetrics?.top ?? panelPosition.top ?? VIEWPORT_MARGIN;
  const primaryPanelHeight =
    primaryPanelMetrics?.height ??
    LIST_MAX_HEIGHT + DROPDOWN_PANEL.padding * 2 + 40;

  return createPortal(
    <>
      <div
        ref={panelRef}
        data-dropdown-main-panel-anchor
        className={`${DROPDOWN_CLASSES.panel} fixed flex flex-col`}
        style={{
          top: panelPosition.top,
          bottom: panelPosition.bottom,
          left,
          width: DROPDOWN_WIDTH,
        }}
      >
        <div className={DROPDOWN_CLASSES.searchContainer}>
          <Search
            size={DROPDOWN_ITEM.iconSize}
            className="shrink-0 text-text-3"
          />
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={tauriSelectAll}
            placeholder={placeholder}
            className={DROPDOWN_CLASSES.searchInput}
          />
        </div>

        <div
          className={DROPDOWN_CLASSES.optionsContainerOverlay}
          style={{ maxHeight: LIST_MAX_HEIGHT }}
        >
          {filteredItems.length === 0 ? (
            <div className={DROPDOWN_CLASSES.listMessage}>
              {tCommon("selectors.modelSelector.noResults")}
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const rowKeyboardProps = isHeaderItem(item)
                ? undefined
                : keyboard.getItemProps(index);
              const rowUsesSubmenu = itemUsesSourceSubmenu(item);
              return (
                <DropdownRow
                  key={item.id}
                  item={item}
                  keyboardProps={rowKeyboardProps}
                  onItemMouseEnter={(hoveredElement) => {
                    closeModelPropertiesDropdown(hoveredElement);
                    if (!rowUsesSubmenu) setSubmenuOpen(false);
                  }}
                  onRowMouseEnter={(event) => {
                    const rowTop =
                      event.currentTarget.getBoundingClientRect().top;
                    setSubmenuAnchorTop(rowTop);
                    notifySidePanelAnchorChange();
                    if (rowUsesSubmenu) {
                      openSourcesForItem(item, rowTop);
                    }
                  }}
                  submenuSide={rowUsesSubmenu ? submenuSide : undefined}
                />
              );
            })
          )}
        </div>
      </div>

      {effectiveSubmenuOpen && (
        <HoverSafeSubmenuBridge
          side={submenuSide}
          primaryLeft={left}
          primaryTop={primaryPanelTop}
          primaryWidth={DROPDOWN_WIDTH}
          primaryHeight={primaryPanelHeight}
          submenuLeft={submenuLeft}
          submenuTop={submenuTop}
          submenuWidth={SUBMENU_WIDTH}
          submenuHeight={submenuEstimatedHeight}
        />
      )}

      {effectiveSubmenuOpen && (
        <div
          data-dropdown-side-panel-anchor
          data-dropdown-side-panel-left={submenuLeft}
          data-dropdown-side-panel-top={submenuTop}
          data-dropdown-side-panel-height={submenuEstimatedHeight}
          className={`${DROPDOWN_CLASSES.panel} fixed flex flex-col ${DROPDOWN_PANEL.paddingClass}`}
          style={{
            top: submenuTop,
            left: submenuLeft,
            width: SUBMENU_WIDTH,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className={DROPDOWN_CLASSES.sectionLabel}>
            {tCommon("selectors.modelSelector.selectAccount")}
          </div>
          <div
            className="scrollbar-overlay flex flex-col overflow-y-auto"
            style={{ maxHeight: LIST_MAX_HEIGHT }}
          >
            {sourceItems.map((item, index) => (
              <DropdownRow
                key={item.id}
                item={item}
                keyboardProps={{
                  "data-dropdown-item-index": index,
                  "data-dropdown-keyboard-highlight":
                    effectiveSubmenuSelectedIndex === index
                      ? "true"
                      : undefined,
                  "aria-selected": effectiveSubmenuSelectedIndex === index,
                  onMouseEnter: () => setSubmenuSelectedIndex(index),
                  onClick: () => selectSubmenuSource(index),
                }}
                onItemMouseEnter={closeModelPropertiesDropdown}
              />
            ))}
          </div>
        </div>
      )}
    </>,
    document.body
  );
};

UnifiedModelDropdown.displayName = "UnifiedModelDropdown";
