/**
 * NavigationSidebar
 *
 * Main navigation sidebar with tabs and menu items.
 * Used for: Home page, Config page navigation
 */
import {
  ChevronDown,
  ChevronRight,
  type LucideIcon,
  Search,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";

import Input from "@src/components/Input";
import TabPill from "@src/components/TabPill";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import SidebarBase from "../SidebarBase";
import { SidebarList } from "../blocks";
import HoverAnimatedIcon from "../components/HoverAnimatedIcon";
import NavigationMenu from "../components/NavigationMenu";
import type {
  NavigationMenuItem,
  NavigationMenuRowAction,
} from "../components/NavigationMenu/config";
import type { SidebarTab } from "../types";

// ============================================
// Types
// ============================================

export interface NavigationSidebarSearchConfig {
  value: string;
  filterValue?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  noResultsTitle?: string;
}

export interface NavigationSidebarProps {
  items: SidebarTab[];
  activeKey: string;
  onChange: (key: string) => void;
  menuItems: NavigationMenuItem[];
  pinnedMenuItems?: NavigationMenuItem[];
  selectedKey?: string;
  onMenuItemClick?: (key: string, item: NavigationMenuItem) => void;
  onMenuItemContextMenu?: (
    e: React.MouseEvent,
    key: string,
    item: NavigationMenuItem
  ) => void;
  renderMenuItemWrapper?: (
    item: NavigationMenuItem,
    node: React.ReactElement
  ) => React.ReactElement;
  defaultOpenKeys?: string[];
  bottomContent?: React.ReactNode;
  enableHoverIconAnimation?: boolean;
  /** Add-new button in the traffic lights area (passed to SidebarBase) */
  onAddNew?: () => void;
  /** Icon for the add-new button */
  addIcon?: LucideIcon;
  /** Tooltip for the add-new button */
  addLabel?: string;
  /** Optional rich tooltip content for the add-new button */
  addTooltipContent?: React.ReactNode;
  /** Extra controls rendered before add-new (passed to SidebarBase) */
  beforeAddNewActions?: React.ReactNode;
  /** Extra controls next to add-new (passed to SidebarBase) */
  headerActions?: React.ReactNode;
  /** Preserve top padding for the scrollable menu list. */
  listTopPadding?: boolean;
  /** Optional ghost search row rendered above the scrollable menu list. */
  search?: NavigationSidebarSearchConfig;
  /** Optional control row rendered between search and pinned/list content. */
  preListContent?: React.ReactNode;
  /** Show loading placeholder instead of menu items */
  isLoading?: boolean;
  /** Enable compact 32px navigation rows for dense sidebars. */
  compactRows?: boolean;
  /** Paint an opaque sidebar surface instead of honoring sidebar transparency. */
  solidSurface?: boolean;
  /** Enable collapse/expand on section headers (separator-based groups) */
  collapsibleSections?: boolean;
  /**
   * Optional controlled value for the collapsed-section set. When provided
   * together with `onCollapsedSectionsChange`, the parent fully owns the
   * collapse state (e.g. to expose a "Collapse All" action). When omitted,
   * the sidebar manages its own local state.
   */
  collapsedSectionIds?: Set<string>;
  onCollapsedSectionsChange?: (next: Set<string>) => void;
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getMenuItemSearchText(item: NavigationMenuItem): string {
  return [item.label, item.searchText, item.shortcut]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function filterMenuItem(
  item: NavigationMenuItem,
  normalizedQuery: string
): NavigationMenuItem | null {
  const filteredChildren = item.children
    ?.map((child) => filterMenuItem(child, normalizedQuery))
    .filter((child): child is NavigationMenuItem => Boolean(child));

  if (
    getMenuItemSearchText(item).includes(normalizedQuery) ||
    (filteredChildren && filteredChildren.length > 0)
  ) {
    return filteredChildren ? { ...item, children: filteredChildren } : item;
  }

  return null;
}

function filterMenuItems(
  items: readonly NavigationMenuItem[],
  normalizedQuery: string
): NavigationMenuItem[] {
  if (!normalizedQuery) return [...items];

  const filteredItems: NavigationMenuItem[] = [];
  let pendingSeparator: NavigationMenuItem | null = null;

  for (const item of items) {
    if (item.id?.startsWith("separator-")) {
      pendingSeparator = item;
      continue;
    }

    const filteredItem = filterMenuItem(item, normalizedQuery);
    if (!filteredItem) continue;

    if (pendingSeparator) {
      filteredItems.push(pendingSeparator);
      pendingSeparator = null;
    }
    filteredItems.push(filteredItem);
  }

  return filteredItems;
}

// ============================================
// Component
// ============================================

const NavigationSidebar: React.FC<NavigationSidebarProps> = React.memo(
  ({
    items,
    activeKey,
    onChange,
    menuItems,
    pinnedMenuItems = [],
    selectedKey,
    onMenuItemClick,
    onMenuItemContextMenu,
    renderMenuItemWrapper,
    defaultOpenKeys = [],
    bottomContent,
    enableHoverIconAnimation = false,
    onAddNew,
    addIcon,
    addLabel,
    addTooltipContent,
    beforeAddNewActions,
    headerActions,
    listTopPadding = false,
    search,
    preListContent,
    isLoading = false,
    compactRows = false,
    solidSurface = false,
    collapsibleSections = false,
    collapsedSectionIds,
    onCollapsedSectionsChange,
  }) => {
    const normalizedSearchQuery = useMemo(
      () => normalizeSearchValue(search?.filterValue ?? search?.value ?? ""),
      [search?.filterValue, search?.value]
    );
    const filteredPinnedMenuItems = useMemo(
      () => filterMenuItems(pinnedMenuItems, normalizedSearchQuery),
      [normalizedSearchQuery, pinnedMenuItems]
    );
    const filteredMenuItems = useMemo(
      () => filterMenuItems(menuItems, normalizedSearchQuery),
      [menuItems, normalizedSearchQuery]
    );
    const hasSearchInput = Boolean(search?.value.trim());

    // Memoize section grouping — only recompute when menuItems changes
    // Separator items (id starts with "separator-") split the list into sections.
    // If a separator has a non-empty label, it becomes the section title.
    const sections = useMemo(() => {
      const result: {
        id: string;
        title?: string;
        items: NavigationMenuItem[];
        headerActions?: readonly NavigationMenuRowAction[];
      }[] = [];
      let currentSection: NavigationMenuItem[] = [];
      let currentTitle: string | undefined;
      let currentId = "default";
      let currentHeaderActions: readonly NavigationMenuRowAction[] | undefined;

      filteredMenuItems.forEach((item, index) => {
        if (item.id?.startsWith("separator-")) {
          if (index > 0) {
            result.push({
              id: currentId,
              title: currentTitle,
              items: currentSection,
              headerActions: currentHeaderActions,
            });
            currentSection = [];
          }
          currentId = item.id.replace("separator-", "");
          currentTitle = item.label || undefined;
          currentHeaderActions =
            item.rowActions && item.rowActions.length > 0
              ? item.rowActions
              : undefined;
        } else {
          currentSection.push(item);
        }
      });

      if (currentSection.length > 0 || currentTitle) {
        result.push({
          id: currentId,
          title: currentTitle,
          items: currentSection,
          headerActions: currentHeaderActions,
        });
      }

      return result;
    }, [filteredMenuItems]);

    const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState<
      Set<string>
    >(new Set());

    const isControlled = collapsedSectionIds !== undefined;
    const collapsedSections = isControlled
      ? collapsedSectionIds
      : uncontrolledCollapsed;

    const toggleSection = useCallback(
      (sectionId: string) => {
        const next = new Set(collapsedSections);
        if (next.has(sectionId)) {
          next.delete(sectionId);
        } else {
          next.add(sectionId);
        }
        if (isControlled) {
          onCollapsedSectionsChange?.(next);
        } else {
          setUncontrolledCollapsed(next);
        }
      },
      [collapsedSections, isControlled, onCollapsedSectionsChange]
    );

    // Stable selected keys array
    const selectedKeys = useMemo(
      () => (selectedKey ? [selectedKey] : []),
      [selectedKey]
    );

    const resolvedDefaultOpenKeys = useMemo(() => {
      if (defaultOpenKeys.length > 0) return defaultOpenKeys;
      return sections.flatMap((section) =>
        section.items.flatMap((item) =>
          item.children && item.children.length > 0 ? [item.key] : []
        )
      );
    }, [defaultOpenKeys, sections]);

    // Stable handler refs — avoid inline arrow wrappers
    const handleMenuItemClick = useCallback(
      (key: string, item: NavigationMenuItem) => {
        onMenuItemClick?.(key, item);
      },
      [onMenuItemClick]
    );

    const handleMenuItemContextMenu = useCallback(
      (e: React.MouseEvent, key: string, item: NavigationMenuItem) => {
        onMenuItemContextMenu?.(e, key, item);
      },
      [onMenuItemContextMenu]
    );

    // Memoize TabPill tabs array
    const tabPillTabs = useMemo(
      () =>
        items.map((tab) => ({
          key: tab.key,
          label: tab.label,
          icon:
            tab.icon && typeof tab.icon !== "string"
              ? enableHoverIconAnimation && tab.iconName
                ? React.createElement(HoverAnimatedIcon, {
                    icon: tab.icon,
                    iconName: tab.iconName,
                    className: "h-[14px] w-[14px]",
                    strokeWidth: 2,
                  })
                : React.createElement(tab.icon, {
                    className: "h-[14px] w-[14px]",
                    strokeWidth: 2,
                  })
              : undefined,
        })),
      [enableHoverIconAnimation, items]
    );

    return (
      <SidebarBase
        onAddNew={onAddNew}
        addIcon={addIcon}
        addLabel={addLabel}
        addTooltipContent={addTooltipContent}
        beforeAddNewActions={beforeAddNewActions}
        headerActions={headerActions}
        solidSurface={solidSurface}
      >
        {preListContent}

        {/* Tab Header */}
        {items.length > 0 && (
          <div
            className="flex h-9 items-center px-3"
            data-tauri-drag-region
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          >
            <div
              className="flex w-full min-w-0"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <TabPill
                activeTab={activeKey}
                tabs={tabPillTabs}
                onChange={onChange}
                iconOnly
              />
            </div>
          </div>
        )}

        {search && (
          <div className="px-3 pt-1">
            <Input
              type="search"
              value={search.value}
              onChange={search.onChange}
              placeholder={search.placeholder}
              borderless
              bgless
              autoHeight
              allowClear
              prefix={
                <Search size={14} strokeWidth={2} className="text-text-3" />
              }
              className="h-9 rounded-lg text-text-1 [&_.input-inner]:!h-9 [&_.input-inner]:gap-3 [&_.input-inner]:!px-2 [&_.input-prefix]:mr-0"
              inputClassName="text-[13px] font-normal placeholder:text-text-3"
              style={{ height: 36 }}
              inputStyle={{ transform: "none" }}
            />
          </div>
        )}

        {filteredPinnedMenuItems.length > 0 && (
          <div className="px-3 pt-1">
            <NavigationMenu
              items={filteredPinnedMenuItems}
              selectedKeys={selectedKeys}
              collapsed={false}
              defaultOpenKeys={resolvedDefaultOpenKeys}
              enableHoverIconAnimation={enableHoverIconAnimation}
              compactRows={compactRows}
              onMenuItemClick={handleMenuItemClick}
              onMenuItemContextMenu={handleMenuItemContextMenu}
              renderMenuItemWrapper={renderMenuItemWrapper}
            />
          </div>
        )}

        {/* Section Container */}
        <SidebarList isLoading={isLoading} topPadding={listTopPadding}>
          {hasSearchInput &&
          filteredPinnedMenuItems.length === 0 &&
          sections.length === 0 ? (
            <Placeholder
              variant="no-results"
              title={search?.noResultsTitle}
              placement="sidebar"
            />
          ) : (
            sections.map((section) => {
              const isSectionCollapsed =
                !hasSearchInput &&
                collapsibleSections &&
                collapsedSections.has(section.id);

              return (
                <div key={section.id}>
                  {section.title &&
                    (collapsibleSections ? (
                      <div
                        className={`${isSectionCollapsed ? "" : "mb-px"} group/section-title flex h-7 cursor-pointer items-center gap-2 pl-2`}
                        onClick={() => {
                          if (!hasSearchInput) toggleSection(section.id);
                        }}
                      >
                        <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wider text-text-2">
                          {section.title}
                        </span>
                        <span className="hidden flex-shrink-0 items-center leading-none text-text-2 group-hover/section-title:inline-flex">
                          {isSectionCollapsed ? (
                            <ChevronRight size={14} strokeWidth={2} />
                          ) : (
                            <ChevronDown size={14} strokeWidth={2} />
                          )}
                        </span>
                        {section.headerActions && (
                          <span className="ml-auto hidden flex-shrink-0 items-center gap-0.5 leading-none text-text-2 group-hover/section-title:inline-flex">
                            {section.headerActions.map((action) => {
                              const ActionIcon = action.icon;
                              return (
                                <button
                                  key={action.label}
                                  type="button"
                                  title={action.label}
                                  aria-label={action.label}
                                  className="flex h-5 w-5 items-center justify-center rounded text-text-2 transition-colors duration-150 hover:bg-fill-2 hover:text-text-1 focus:outline-none"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    action.onClick(event);
                                  }}
                                >
                                  {ActionIcon ? (
                                    <ActionIcon size={14} strokeWidth={2} />
                                  ) : null}
                                </button>
                              );
                            })}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
                        {section.title}
                      </div>
                    ))}
                  {!isSectionCollapsed && (
                    <NavigationMenu
                      items={section.items}
                      selectedKeys={selectedKeys}
                      collapsed={false}
                      defaultOpenKeys={resolvedDefaultOpenKeys}
                      enableHoverIconAnimation={enableHoverIconAnimation}
                      compactRows={compactRows}
                      onMenuItemClick={handleMenuItemClick}
                      onMenuItemContextMenu={handleMenuItemContextMenu}
                      renderMenuItemWrapper={renderMenuItemWrapper}
                    />
                  )}
                </div>
              );
            })
          )}
        </SidebarList>

        {/* Bottom Content */}
        {bottomContent}
      </SidebarBase>
    );
  }
);

NavigationSidebar.displayName = "NavigationSidebar";

export default NavigationSidebar;
