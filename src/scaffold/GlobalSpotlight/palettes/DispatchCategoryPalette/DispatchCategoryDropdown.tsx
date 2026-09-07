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
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { formatModelAgentType } from "@src/assets/providers";
import AnyIcon from "@src/components/AnyIcon";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import ModelIcon from "@src/components/ModelIcon";
import Tooltip from "@src/components/Tooltip";
import {
  type UseDropdownListNavigationReturn,
  useDropdownEngine,
} from "@src/hooks/dropdown";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { useFilteredItems } from "@src/hooks/search";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";
import { getViewportSize } from "@src/util/ui/window/viewport";

import type { SpotlightItem } from "../../types";
import type { DispatchCategoryPaletteProps } from "./types";
import { useDispatchCategoryOptions } from "./useDispatchCategoryOptions";

const LIST_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 12;
/** Lower bound when the trigger is very narrow (e.g. collapsed sidebar). */
const MIN_DROPDOWN_WIDTH = 320;

function getItemData(item: SpotlightItem): Record<string, unknown> {
  return (item.data as Record<string, unknown> | undefined) ?? {};
}

const AvailableKeyCount: React.FC<{ keys: KeyVaultAccount[] }> = ({ keys }) => {
  const { t } = useTranslation("common");
  const hasKeys = keys.length > 0;

  const keyList = hasKeys ? (
    <div className="flex min-w-[180px] flex-col gap-1 py-0.5">
      {keys.map((key) => (
        <div key={key.id} className="flex min-w-0 items-center gap-2">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <ModelIcon agentType={key.modelType} size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate">{key.name}</span>
          <span className="shrink-0 text-[11px] text-text-3">
            {formatModelAgentType(key.modelType)}
          </span>
        </div>
      ))}
    </div>
  ) : (
    <span>{t("selectors.modelSelector.noCompatibleAccounts")}</span>
  );

  return (
    <Tooltip
      content={keyList}
      position="right"
      mouseEnterDelay={150}
      framedPanel
      smartPlacement
    >
      <span
        className="flex shrink-0 items-center gap-1.5 text-[11px] text-text-2 tabular-nums"
        aria-label={`${keys.length} ${t("labels.keys")}`}
      >
        {keys.length}
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            hasKeys ? "bg-success-6" : "bg-danger-6"
          }`}
        />
      </span>
    </Tooltip>
  );
};

interface DropdownRowProps {
  item: SpotlightItem;
  keyboardProps: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
}

const DropdownRow: React.FC<DropdownRowProps> = ({ item, keyboardProps }) => {
  const data = getItemData(item);
  const rightContent = data.rightContent as React.ReactNode | undefined;
  const availableKeys = data.availableKeys as KeyVaultAccount[] | undefined;
  const isCurrent = data.isCurrentSelection === true;
  const isDisabled = data.disabled === true;
  const tagLabel = typeof data.tagLabel === "string" ? data.tagLabel : null;
  const testId = typeof data.testId === "string" ? data.testId : undefined;

  const renderedIcon = useMemo(() => {
    if (isCurrent) {
      return (
        <HugeiconsIcon
          icon={Tick01Icon}
          data-icon="check"
          size={DROPDOWN_ITEM.iconSize}
          strokeWidth={2.25}
          className="text-primary-6"
        />
      );
    }
    return <AnyIcon icon={item.icon} size={16} className="text-text-2" />;
  }, [item.icon, isCurrent]);

  return (
    <button
      type="button"
      data-testid={testId}
      {...keyboardProps}
      disabled={isDisabled}
      className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full justify-start ${
        isCurrent ? DROPDOWN_CLASSES.itemSelected : ""
      } ${isDisabled ? "cursor-not-allowed opacity-50" : ""}`}
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
      {tagLabel && (
        <span className="shrink-0 text-[11px] text-text-3">{tagLabel}</span>
      )}
      {availableKeys ? (
        <AvailableKeyCount keys={availableKeys} />
      ) : (
        rightContent && <div className="shrink-0">{rightContent}</div>
      )}
    </button>
  );
};

interface DispatchCategoryDropdownProps extends DispatchCategoryPaletteProps {
  /** Element the dropdown is anchored to. */
  anchorRef: React.RefObject<HTMLElement | null>;
  placement?: "top" | "bottom";
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
  allowedCliAgentTypes,
  cliOnly = false,
  includeHumanSession = false,
  anchorRef,
  placement = "bottom",
}) => {
  const { t: tCommon } = useTranslation("common");
  const inputRef = useRef<HTMLInputElement>(null);

  const { allOptions, groups, optionToItem } = useDispatchCategoryOptions({
    isOpen,
    hideOrgs,
    hideCliAgents,
    allowedCliAgentTypes,
    cliOnly,
    includeHumanSession,
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
    if (data.isHeader === true || data.disabled === true) return;
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
    placement,
    gap: DROPDOWN_PANEL.triggerGap,
    listNavigation: {
      items,
      onSelect: handleSelect,
      isItemSelectable: (item) => {
        const data = getItemData(item);
        return data.isHeader !== true && data.disabled !== true;
      },
      initialSelectedIndex: -1,
    },
  });

  if (!isOpen || !isPositioned) return null;

  const { width: vw } = getViewportSize();
  const width = Math.min(
    Math.max(MIN_DROPDOWN_WIDTH, panelPosition.width),
    vw - VIEWPORT_MARGIN * 2
  );
  const centeredLeft = panelPosition.left + (panelPosition.width - width) / 2;
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(centeredLeft, vw - VIEWPORT_MARGIN - width)
  );

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      className={`${DROPDOWN_CLASSES.panel} fixed flex flex-col`}
      style={{
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left,
        width,
      }}
    >
      <DropdownSearch
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={tCommon("filters.searchAgentOrOrg")}
      />

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
