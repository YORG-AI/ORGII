/**
 * NavigationSidebar
 *
 * Main navigation sidebar with tabs and menu items.
 * Used by Settings and Workstation navigation surfaces.
 */
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import React, {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Placeholder } from "@src/components/Placeholder";
import TabPill from "@src/components/TabPill";

import SidebarBase from "../SidebarBase";
import { SidebarList, SidebarMenuSearchInput } from "../blocks";
import HoverAnimatedIcon from "../components/HoverAnimatedIcon";
import NavigationMenu from "../components/NavigationMenu";
import { NavigationMenuRowActionButton } from "../components/NavigationMenu/NavigationMenu/RowActionButton";
import type { NavigationMenuItemClickHandler } from "../components/NavigationMenu/NavigationMenu/types";
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
  /** Keep filtering active while a caller renders the shared input elsewhere. */
  showInput?: boolean;
}

export interface NavigationSidebarProps {
  items: SidebarTab[];
  activeKey: string;
  onChange: (key: string) => void;
  menuItems: NavigationMenuItem[];
  pinnedMenuItems?: NavigationMenuItem[];
  selectedKey?: string;
  onMenuItemClick?: NavigationMenuItemClickHandler;
  onSubmenuOpenChange?: (key: string, open: boolean) => void;
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
  /** Leading content in the Windows/Linux sidebar chrome row. */
  hostTopBarLeadingContent?: React.ReactNode;
  /** Equivalent content rendered below the traffic-light row on macOS. */
  macTopBarFollowingContent?: React.ReactNode;
  /** Preserve top padding for the scrollable menu list. */
  listTopPadding?: boolean;
  /** Optional ghost search row rendered above the scrollable menu list. */
  search?: NavigationSidebarSearchConfig;
  /** Optional control row rendered between search and pinned/list content. */
  preListContent?: React.ReactNode;
  /** Show loading placeholder instead of menu items */
  isLoading?: boolean;
  /** Optional loading UI that mirrors the current sidebar surface. */
  loadingContent?: React.ReactNode;
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
  /** Scroll a newly revealed row into view after its section mounts. */
  revealMenuItemRequest?: {
    key: string;
    requestId: number;
  };
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

interface NavigationMenuSection {
  id: string;
  title?: string;
  /** Leading glyph beside the title (e.g. the pinned-workspace pin). */
  titleIcon?: ReactNode;
  items: NavigationMenuItem[];
  headerActions?: readonly NavigationMenuRowAction[];
}

function groupMenuItemsIntoSections(
  items: readonly NavigationMenuItem[]
): NavigationMenuSection[] {
  const result: NavigationMenuSection[] = [];
  let currentSection: NavigationMenuItem[] = [];
  let currentTitle: string | undefined;
  let currentTitleIcon: ReactNode | undefined;
  let currentId = "default";
  let currentHeaderActions: readonly NavigationMenuRowAction[] | undefined;

  items.forEach((item, index) => {
    if (item.id?.startsWith("separator-")) {
      if (index > 0) {
        result.push({
          id: currentId,
          title: currentTitle,
          titleIcon: currentTitleIcon,
          items: currentSection,
          headerActions: currentHeaderActions,
        });
        currentSection = [];
      }
      currentId = item.id.replace("separator-", "");
      currentTitle = item.label || undefined;
      currentTitleIcon = item.iconElement;
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
      titleIcon: currentTitleIcon,
      items: currentSection,
      headerActions: currentHeaderActions,
    });
  }

  return result;
}

function NavigationSidebarSectionHeader({
  title,
  titleIcon,
}: {
  title: string;
  titleIcon?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5 px-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
      {titleIcon}
      <span className="min-w-0 truncate">{title}</span>
    </div>
  );
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
    onSubmenuOpenChange,
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
    hostTopBarLeadingContent,
    macTopBarFollowingContent,
    listTopPadding = false,
    search,
    preListContent,
    isLoading = false,
    loadingContent,
    solidSurface = false,
    collapsibleSections = false,
    collapsedSectionIds,
    onCollapsedSectionsChange,
    revealMenuItemRequest,
  }) => {
    const menuRevealRootRef = useRef<HTMLDivElement>(null);
    const completedRevealRequestIdRef = useRef<number | null>(null);
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

    // Separator items (id starts with "separator-") split the list into sections.
    // If a separator has a non-empty label, it becomes the section title.
    const pinnedSections = useMemo(
      () => groupMenuItemsIntoSections(filteredPinnedMenuItems),
      [filteredPinnedMenuItems]
    );
    const sections = useMemo(
      () => groupMenuItemsIntoSections(filteredMenuItems),
      [filteredMenuItems]
    );

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

    useEffect(() => {
      if (
        !revealMenuItemRequest ||
        completedRevealRequestIdRef.current === revealMenuItemRequest.requestId
      ) {
        return;
      }
      const frame = window.requestAnimationFrame(() => {
        const row = Array.from(
          menuRevealRootRef.current?.querySelectorAll<HTMLElement>(
            "[data-menu-item-id]"
          ) ?? []
        ).find(
          (candidate) =>
            candidate.getAttribute("data-menu-item-id") ===
            revealMenuItemRequest.key
        );
        if (row) {
          row.scrollIntoView({ block: "nearest", inline: "nearest" });
          completedRevealRequestIdRef.current = revealMenuItemRequest.requestId;
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }, [collapsedSections, revealMenuItemRequest, sections]);

    // Stable selected keys array
    const selectedKeys = useMemo(
      () => (selectedKey ? [selectedKey] : []),
      [selectedKey]
    );

    const resolvedDefaultOpenKeys = useMemo(() => {
      if (defaultOpenKeys.length > 0) return defaultOpenKeys;
      return [...pinnedSections, ...sections].flatMap((section) =>
        section.items.flatMap((item) =>
          item.children && item.children.length > 0 ? [item.key] : []
        )
      );
    }, [defaultOpenKeys, pinnedSections, sections]);

    // Stable handler refs — avoid inline arrow wrappers
    const handleMenuItemClick = useCallback(
      (key: string, item: NavigationMenuItem, event: React.MouseEvent) => {
        onMenuItemClick?.(key, item, event);
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
        hostTopBarLeadingContent={hostTopBarLeadingContent}
        macTopBarFollowingContent={macTopBarFollowingContent}
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

        {search && search.showInput !== false && (
          <div className="px-3 pt-1">
            <SidebarMenuSearchInput
              value={search.value}
              onChange={search.onChange}
              placeholder={search.placeholder}
            />
          </div>
        )}

        {pinnedSections.length > 0 && (
          <div className="flex flex-col gap-3 px-3 pt-1">
            {pinnedSections.map((section) => {
              const isSectionCollapsed =
                !hasSearchInput &&
                collapsibleSections &&
                collapsedSections.has(section.id);

              return (
                <div key={section.id} data-sidebar-section-id={section.id}>
                  {section.title &&
                    (collapsibleSections ? (
                      <div
                        data-sidebar-section-toggle={section.id}
                        role="button"
                        tabIndex={0}
                        aria-expanded={!isSectionCollapsed}
                        className={`${isSectionCollapsed ? "" : "mb-px"} group/section-title flex h-7 cursor-pointer items-center gap-2 pl-2`}
                        onClick={() => {
                          if (!hasSearchInput) toggleSection(section.id);
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.target !== event.currentTarget ||
                            (event.key !== "Enter" && event.key !== " ")
                          ) {
                            return;
                          }
                          event.preventDefault();
                          if (!hasSearchInput) toggleSection(section.id);
                        }}
                      >
                        {section.titleIcon}
                        <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wider text-text-2">
                          {section.title}
                        </span>
                        <span className="hidden flex-shrink-0 items-center leading-none text-text-2 group-hover/section-title:inline-flex">
                          <NavigationMenuRowActionButton
                            icon={
                              isSectionCollapsed ? ChevronRight : ChevronDown
                            }
                            label={section.title}
                            onClick={() => {
                              if (!hasSearchInput) toggleSection(section.id);
                            }}
                          />
                        </span>
                      </div>
                    ) : (
                      <NavigationSidebarSectionHeader
                        title={section.title}
                        titleIcon={section.titleIcon}
                      />
                    ))}
                  {!isSectionCollapsed && (
                    <NavigationMenu
                      items={section.items}
                      selectedKeys={selectedKeys}
                      collapsed={false}
                      defaultOpenKeys={resolvedDefaultOpenKeys}
                      onMenuItemClick={handleMenuItemClick}
                      onSubmenuOpenChange={onSubmenuOpenChange}
                      onMenuItemContextMenu={handleMenuItemContextMenu}
                      renderMenuItemWrapper={renderMenuItemWrapper}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Section Container */}
        <SidebarList
          isLoading={isLoading}
          loadingContent={loadingContent}
          topPadding={listTopPadding}
          scrollContainerRef={menuRevealRootRef}
        >
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
                <div key={section.id} data-sidebar-section-id={section.id}>
                  {section.title &&
                    (collapsibleSections ? (
                      <div
                        data-sidebar-section-toggle={section.id}
                        role="button"
                        tabIndex={0}
                        aria-expanded={!isSectionCollapsed}
                        className={`${isSectionCollapsed ? "" : "mb-px"} group/section-title flex h-7 cursor-pointer items-center gap-2 pl-2`}
                        onClick={() => {
                          if (!hasSearchInput) toggleSection(section.id);
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.target !== event.currentTarget ||
                            (event.key !== "Enter" && event.key !== " ")
                          ) {
                            return;
                          }
                          event.preventDefault();
                          if (!hasSearchInput) toggleSection(section.id);
                        }}
                      >
                        {section.titleIcon}
                        <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wider text-text-2">
                          {section.title}
                        </span>
                        <span className="hidden flex-shrink-0 items-center leading-none text-text-2 group-hover/section-title:inline-flex">
                          <NavigationMenuRowActionButton
                            icon={
                              isSectionCollapsed ? ChevronRight : ChevronDown
                            }
                            label={section.title ?? section.id}
                            onClick={() => {
                              if (!hasSearchInput) toggleSection(section.id);
                            }}
                          />
                        </span>
                        {section.headerActions && (
                          <span
                            className={`ml-auto flex-shrink-0 items-center gap-1 leading-none text-text-2 ${
                              section.headerActions.some(
                                (action) => action.active
                              )
                                ? "inline-flex"
                                : "hidden group-hover/section-title:inline-flex"
                            }`}
                          >
                            {section.headerActions.map((action) => {
                              return (
                                <NavigationMenuRowActionButton
                                  key={action.label}
                                  icon={action.icon}
                                  iconClassName={action.iconClassName}
                                  label={action.label}
                                  active={action.active}
                                  dataTestId={action.dataTestId}
                                  onClick={action.onClick}
                                />
                              );
                            })}
                          </span>
                        )}
                      </div>
                    ) : (
                      <NavigationSidebarSectionHeader
                        title={section.title}
                        titleIcon={section.titleIcon}
                      />
                    ))}
                  {!isSectionCollapsed && (
                    <NavigationMenu
                      items={section.items}
                      selectedKeys={selectedKeys}
                      collapsed={false}
                      defaultOpenKeys={resolvedDefaultOpenKeys}
                      onMenuItemClick={handleMenuItemClick}
                      onSubmenuOpenChange={onSubmenuOpenChange}
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
