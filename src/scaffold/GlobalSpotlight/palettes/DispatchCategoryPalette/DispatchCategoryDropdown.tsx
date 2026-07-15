/**
 * DispatchCategoryDropdown
 *
 * Anchored, compact variant of `DispatchCategoryPalette`. Shares
 * data + option building with the Spotlight variant via
 * `useDispatchCategoryOptions`, so both surfaces render the same
 * agents in the same order.
 *
 * The active variant is selected by the `general.modelPickerStyle`
 * setting and dispatched from the caller (e.g. SessionCreator).
 */
import { Check, Search } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

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

import type { SpotlightItem } from "../../types";
import type { DispatchCategoryPaletteProps } from "./types";
import { useDispatchCategoryOptions } from "./useDispatchCategoryOptions";

const LIST_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 12;
/** Lower bound when the trigger is very narrow (e.g. collapsed sidebar). */
const MIN_DROPDOWN_WIDTH = 240;

function getItemData(item: SpotlightItem): Record<string, unknown> {
  return (item.data as Record<string, unknown> | undefined) ?? {};
}

interface DropdownRowProps {
  item: SpotlightItem;
  keyboardProps: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
}

const DropdownRow: React.FC<DropdownRowProps> = ({ item, keyboardProps }) => {
  const data = getItemData(item);
  const rightContent = data.rightContent as React.ReactNode | undefined;
  const isCurrent = data.isCurrentSelection === true;
  const testId = typeof data.testId === "string" ? data.testId : undefined;

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
      return <i className={`${item.icon} text-[16px] text-text-2`} />;
    }
    return React.createElement(item.icon, {
      size: 16,
      className: "text-text-2",
    });
  }, [item.icon, isCurrent]);

  return (
    <button
      type="button"
      data-testid={testId}
      {...keyboardProps}
      className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full justify-start ${
        isCurrent ? DROPDOWN_CLASSES.itemSelected : ""
      }`}
    >
      {renderedIcon && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {renderedIcon}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <span
          className={`truncate text-[13px] ${isCurrent ? "text-primary-6" : "text-text-1"}`}
        >
          {item.label}
        </span>
        {item.desc && (
          <span className="truncate text-[11px] text-text-3">{item.desc}</span>
        )}
      </div>
      {rightContent && <div className="shrink-0">{rightContent}</div>}
    </button>
  );
};

export interface DispatchCategoryDropdownProps extends DispatchCategoryPaletteProps {
  /** Element the dropdown is anchored to. */
  anchorRef: React.RefObject<HTMLElement | null>;
}

export const DispatchCategoryDropdown: React.FC<
  DispatchCategoryDropdownProps
> = ({
  isOpen,
  onClose,
  onSelect,
  currentCategory = "cli_agent",
  currentAgentDefinitionId,
  currentAgentOrgId,
  currentCliAgentType,
  hideOrgs = false,
  hideCliAgents = false,
  cliOnly = false,
  anchorRef,
}) => {
  const { t: tCommon } = useTranslation("common");
  const inputRef = useRef<HTMLInputElement>(null);
  const tauriSelectAll = useTauriSelectAllShortcut();

  const { allOptions, groups, optionToItem } = useDispatchCategoryOptions({
    isOpen,
    hideOrgs,
    hideCliAgents,
    cliOnly,
    currentCategory,
    currentAgentDefinitionId,
    currentAgentOrgId,
    currentCliAgentType,
    onSelect,
    onClose,
  });

  const [searchQuery, setSearchQuery] = useState("");

  const { filteredItems: filteredOptions } = useFilteredItems({
    items: allOptions,
    searchQuery,
    getSearchText: (option) => `${option.name} ${option.desc}`,
  });

  const isSearching = searchQuery.trim().length > 0;

  // Build a flat list of items + headers for rendering. When searching
  // we drop headers since the grouping no longer holds.
  const items = useMemo((): SpotlightItem[] => {
    if (isSearching) {
      return filteredOptions.map((option) => optionToItem(option));
    }
    const result: SpotlightItem[] = [];
    for (const group of groups) {
      result.push({
        id: group.headerId,
        label: group.headerLabel,
        desc: "",
        icon: "",
        type: "option" as const,
        data: { isHeader: true },
        action: () => {},
      });
      for (const option of group.options) {
        result.push(optionToItem(option, group.headerId));
      }
    }
    return result;
  }, [isSearching, filteredOptions, groups, optionToItem]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      setSearchQuery("");
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const handleSelect = useCallback((item: SpotlightItem) => {
    const data = getItemData(item);
    if (data.isHeader === true) return;
    item.action?.();
  }, []);

  const { isPositioned, panelRef, panelPosition, keyboard } = useDropdownEngine<
    HTMLElement,
    SpotlightItem
  >({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    anchorRef,
    placement: "bottom",
    gap: DROPDOWN_PANEL.triggerGap,
    listNavigation: {
      items,
      onSelect: handleSelect,
      isItemSelectable: (item) => getItemData(item).isHeader !== true,
      initialSelectedIndex: -1,
    },
  });

  if (!isOpen || !isPositioned) return null;

  const width = Math.max(MIN_DROPDOWN_WIDTH, panelPosition.width);
  const { width: vw } = getViewportSize();
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(panelPosition.left, vw - VIEWPORT_MARGIN - width)
  );

  return createPortal(
    <div
      ref={panelRef}
      className={`${DROPDOWN_CLASSES.panel} fixed flex flex-col`}
      style={{
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left,
        width,
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
          placeholder={tCommon("filters.searchAgentOrOrg")}
          className={DROPDOWN_CLASSES.searchInput}
        />
      </div>

      <div
        className={DROPDOWN_CLASSES.optionsContainerOverlay}
        style={{ maxHeight: LIST_MAX_HEIGHT }}
      >
        {items.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {tCommon("selectors.modelSelector.noResults")}
          </div>
        ) : (
          items.map((item, index) => {
            const data = getItemData(item);
            if (data.isHeader === true) {
              return (
                <div key={item.id} className={DROPDOWN_CLASSES.sectionLabel}>
                  {item.label}
                </div>
              );
            }
            return (
              <DropdownRow
                key={item.id}
                item={item}
                keyboardProps={keyboard.getItemProps(index)}
              />
            );
          })
        )}
      </div>
    </div>,
    document.body
  );
};

DispatchCategoryDropdown.displayName = "DispatchCategoryDropdown";
