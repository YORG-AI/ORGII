/** Shared searchable dropdown for Settings pages and navigation destinations. */
import React, { useCallback, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import {
  DropdownItem,
  DropdownPanel,
  DropdownSearch,
} from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { HugeiconsIcon, Search01Icon } from "@src/icons";

export interface SettingsSearchDropdownItem {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly icon: React.ComponentProps<typeof AnyIcon>["icon"];
  readonly groupId: string;
  readonly searchTerms?: readonly string[];
}

export interface SettingsSearchDropdownGroup<
  TItem extends SettingsSearchDropdownItem = SettingsSearchDropdownItem,
> {
  readonly id: string;
  readonly label: string | null;
  readonly items: readonly TItem[];
}

interface SettingsSearchDropdownTriggerProps {
  readonly isOpen: boolean;
  readonly listboxId: string;
  readonly onClick: () => void;
}

interface SettingsSearchDropdownBaseProps<
  TItem extends SettingsSearchDropdownItem,
> {
  readonly groups: readonly SettingsSearchDropdownGroup<TItem>[];
  readonly activeItemId?: string;
  readonly onSelect: (item: TItem) => void;
  readonly align?: "left" | "right";
  readonly minWidth?: number;
  readonly onSearchQueryChange?: (query: string) => void;
}

type SettingsSearchDropdownProps<TItem extends SettingsSearchDropdownItem> =
  SettingsSearchDropdownBaseProps<TItem> &
    (
      | {
          readonly variant?: "trigger";
          readonly renderTrigger: (
            props: SettingsSearchDropdownTriggerProps
          ) => React.ReactNode;
        }
      | {
          readonly variant: "search-input";
          readonly renderTrigger?: never;
        }
    );

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

function groupMatchesQuery<TItem extends SettingsSearchDropdownItem>(
  group: SettingsSearchDropdownGroup<TItem>,
  query: string
): SettingsSearchDropdownGroup<TItem> {
  const tokens = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return group;

  return {
    ...group,
    items: group.items.filter((item) => {
      const haystack = normalizeSearchText(
        [item.label, item.id, ...(item.searchTerms ?? [])].join(" ")
      );
      return tokens.every((token) => haystack.includes(token));
    }),
  };
}

function SettingsSearchDropdown<TItem extends SettingsSearchDropdownItem>({
  groups,
  activeItemId,
  onSelect,
  renderTrigger,
  variant = "trigger",
  align = "left",
  minWidth = 240,
  onSearchQueryChange,
}: SettingsSearchDropdownProps<TItem>) {
  const { t: tSettings } = useTranslation("settings");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const listboxId = useId();

  const filteredGroups = useMemo(
    () =>
      groups
        .map((group) => groupMatchesQuery(group, searchQuery))
        .filter((group) => group.items.length > 0),
    [groups, searchQuery]
  );

  const visibleItems = useMemo(
    () => filteredGroups.flatMap((group) => group.items),
    [filteredGroups]
  );

  const handleOpenChange = useCallback((open: boolean) => {
    setSelectorOpen(open);
  }, []);

  const handleSelect = useCallback(
    (item: TItem) => {
      setSelectorOpen(false);
      setSearchQuery("");
      onSearchQueryChange?.("");
      onSelect(item);
    },
    [onSearchQueryChange, onSelect]
  );

  const {
    isOpen,
    isPositioned,
    setIsOpen,
    toggle,
    triggerRef,
    panelRef,
    panelPosition,
    keyboard,
  } = useDropdownEngine<HTMLSpanElement, TItem>({
    open: selectorOpen,
    onOpenChange: handleOpenChange,
    gap: DROPDOWN_PANEL.triggerGapTight,
    placement: "bottom",
    align,
    listNavigation: {
      disableGlobalListener: true,
      items: visibleItems,
      onSelect: handleSelect,
    },
  });

  const itemIndexById = useMemo(
    () => new Map(visibleItems.map((item, index) => [item.id, index])),
    [visibleItems]
  );
  const highlightedItem = visibleItems[keyboard.selectedIndex];
  const activeDescendant = highlightedItem
    ? `${listboxId}-option-${highlightedItem.id}`
    : undefined;
  const isPersistentSearch = variant === "search-input";

  const handleTriggerClick = useCallback(() => {
    if (!isOpen) setSearchQuery("");
    toggle();
  }, [isOpen, toggle]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      onSearchQueryChange?.(value);
      if (isPersistentSearch) {
        const hasQuery = value.trim().length > 0;
        if (hasQuery && !isOpen) setIsOpen(true);
        if (!hasQuery && isOpen) setIsOpen(false);
      } else if (!isOpen) {
        setIsOpen(true);
      }
      keyboard.setSelectedIndex(0);
    },
    [isOpen, isPersistentSearch, keyboard, onSearchQueryChange, setIsOpen]
  );

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "Enter"
      ) {
        keyboard.handleKeyDown(event);
      }
    },
    [keyboard]
  );

  return (
    <>
      <span
        ref={triggerRef}
        className={
          isPersistentSearch ? "block w-full min-w-0" : "inline-flex min-w-0"
        }
      >
        {isPersistentSearch ? (
          <Input
            type="search"
            size="default"
            className="input-sidebar-search"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            placeholder={tSettings("searchPlaceholder")}
            prefix={
              <HugeiconsIcon
                icon={Search01Icon}
                data-icon="search"
                size={14}
                strokeWidth={2}
                className="text-text-3"
              />
            }
            role="combobox"
            aria-controls={listboxId}
            aria-expanded={isOpen}
            aria-autocomplete="list"
            aria-activedescendant={activeDescendant}
            data-testid="settings-navigation-search-input"
          />
        ) : (
          renderTrigger?.({
            isOpen,
            listboxId,
            onClick: handleTriggerClick,
          })
        )}
      </span>

      {isOpen &&
        isPositioned &&
        createPortal(
          <DropdownPanel
            ref={panelRef}
            className={`${DROPDOWN_WIDTHS.panelWidthClass} fixed flex flex-col p-0!`}
            maxHeight={panelPosition.maxHeight}
            onKeyDown={keyboard.handleKeyDown}
            data-testid="settings-navigation-search-panel"
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left:
                panelPosition.right === undefined
                  ? panelPosition.left
                  : undefined,
              right: panelPosition.right,
              minWidth: Math.max(panelPosition.width, minWidth),
            }}
          >
            {!isPersistentSearch && (
              <DropdownSearch
                type="text"
                value={searchQuery}
                onChange={handleSearchChange}
                onKeyDown={handleSearchKeyDown}
                placeholder={tSettings("searchPlaceholder")}
                role="combobox"
                aria-controls={listboxId}
                aria-expanded={isOpen}
                aria-autocomplete="list"
                aria-activedescendant={activeDescendant}
                autoFocus
                testId="settings-navigation-search-input"
              />
            )}
            <div
              id={listboxId}
              role="listbox"
              aria-label={tSettings("searchPlaceholder")}
              className={DROPDOWN_CLASSES.optionsContainerOverlay}
              style={{
                maxHeight: Math.min(
                  360,
                  panelPosition.maxHeight - (isPersistentSearch ? 0 : 44)
                ),
              }}
            >
              {filteredGroups.length === 0 ? (
                <div
                  className={DROPDOWN_CLASSES.listMessage}
                  role="status"
                  aria-live="polite"
                >
                  {tSettings("noSettingsFound", { query: searchQuery.trim() })}
                </div>
              ) : (
                filteredGroups.map((group) => (
                  <React.Fragment key={group.id}>
                    {group.label && (
                      <div
                        className={DROPDOWN_CLASSES.sectionLabel}
                        role="presentation"
                      >
                        {group.label}
                      </div>
                    )}
                    {group.items.map((item) => {
                      const itemIndex = itemIndexById.get(item.id) ?? -1;
                      const keyboardProps = keyboard.getItemProps(itemIndex);
                      const isActive =
                        activeItemId !== undefined && item.id === activeItemId;
                      return (
                        <DropdownItem
                          key={item.id}
                          id={`${listboxId}-option-${item.id}`}
                          dataDropdownItemIndex={itemIndex}
                          role="option"
                          selected={isActive}
                          highlighted={
                            keyboard.keyboardNavigated &&
                            keyboard.selectedIndex === itemIndex
                          }
                          icon={
                            <AnyIcon
                              icon={item.icon}
                              size={DROPDOWN_ITEM.iconSize}
                              className="shrink-0"
                            />
                          }
                          dataTestId={`settings-navigation-search-result-${item.id}`}
                          onMouseEnter={keyboardProps.onMouseEnter}
                          onClick={keyboardProps.onClick}
                        >
                          {item.label}
                        </DropdownItem>
                      );
                    })}
                  </React.Fragment>
                ))
              )}
            </div>
          </DropdownPanel>,
          document.body
        )}
    </>
  );
}

export default SettingsSearchDropdown;
