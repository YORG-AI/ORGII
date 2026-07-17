/**
 * SidebarGroup
 *
 * Collapsible group component for sidebar items.
 * Styled to match NavigationMenu for consistency.
 */
import { ChevronsDownUp, ChevronsUpDown, Plus } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SidebarGroupProps, SidebarItemData } from "../types";
import { renderSidebarIcon } from "../utils/renderIcon";
import SidebarItem from "./SidebarItem";

// ============================================
// SidebarGroup Component
// ============================================

function SidebarGroupInner<T extends SidebarItemData = SidebarItemData>({
  group,
  isCollapsed: controlledCollapsed,
  onToggle,
  onItemClick,
  onItemClose,
  renderItem,
  theme,
  className = "",
}: SidebarGroupProps<T>): React.JSX.Element {
  const { t } = useTranslation("navigation");
  // Internal collapsed state (for uncontrolled mode)
  const [internalCollapsed, setInternalCollapsed] = useState(
    group.defaultCollapsed ?? false
  );

  // Use controlled or internal state
  const isCollapsed =
    controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;

  // Handle toggle — stabilized with useCallback
  const handleToggle = useCallback(() => {
    if (onToggle) {
      onToggle();
    } else {
      setInternalCollapsed((prev) => !prev);
    }
  }, [onToggle]);

  // Stable item click handler
  const handleItemClick = useCallback(
    (item: T) => {
      onItemClick?.(item);
    },
    [onItemClick]
  );

  // Stable item close handler
  const handleItemClose = useCallback(
    (item: T, event: React.MouseEvent) => {
      onItemClose?.(item, event);
    },
    [onItemClose]
  );

  // Theme-aware header style — memoized
  const headerStyle = useMemo(
    () => (theme ? { color: `${theme.foreground}60` } : undefined),
    [theme]
  );

  // Check if any child is selected
  const hasSelectedChild = group.items.some((item) => item.isActive);

  // Don't render anything if no title and no items
  if (!group.title && group.items.length === 0) {
    return <></>;
  }

  return (
    <div className={`sidebar-group mb-1 ${className}`}>
      {/* Group Header - styled like NavigationMenu submenu header */}
      {group.title && group.collapsible !== false && (
        <div
          className={`group mx-2 flex h-[36px] cursor-pointer items-center justify-between rounded-lg px-2 transition-colors duration-150 ${
            hasSelectedChild
              ? "bg-sidebar-selected text-text-1"
              : "text-text-1 hover:bg-sidebar-selected"
          }`}
          onClick={handleToggle}
        >
          <div className="flex items-center gap-3">
            {/* Icon */}
            {group.icon &&
              renderSidebarIcon(group.icon, {
                className: "text-text-1",
              })}
            {/* Title */}
            <span className="text-[13px] text-text-1" style={headerStyle}>
              {group.title}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Add button */}
            {group.onAddNew && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  group.onAddNew?.();
                }}
                className="flex h-5 w-5 items-center justify-center rounded text-text-3 opacity-0 transition-all hover:bg-sidebar-selected hover:text-text-1 group-hover:opacity-100"
                title={group.addButtonLabel || t("sidebar.actions.addNew")}
              >
                <Plus size={12} strokeWidth={2} />
              </button>
            )}
            {/* Chevron */}
            {isCollapsed ? (
              <ChevronsUpDown
                size={12}
                strokeWidth={2}
                className="text-text-2"
              />
            ) : (
              <ChevronsDownUp
                size={12}
                strokeWidth={2}
                className="text-text-2"
              />
            )}
          </div>
        </div>
      )}

      {/* Non-collapsible header */}
      {group.title && group.collapsible === false && (
        <div className="mx-2 flex h-[36px] items-center px-3">
          <span className="text-[11px] font-medium uppercase tracking-wider text-text-3">
            {group.title}
          </span>
        </div>
      )}

      {/* Group Items */}
      {!isCollapsed && (
        <div className={`flex flex-col gap-0 ${group.title ? "mt-1" : ""}`}>
          {group.items.length === 0 ? (
            <div className="mx-2 flex h-[36px] items-center justify-center px-3 text-[12px] text-text-3">
              {t("sidebar.empty.noItems")}
            </div>
          ) : (
            group.items.map((item) => {
              const isActive = item.isActive ?? false;

              // Use custom renderer if provided
              if (renderItem) {
                return (
                  <React.Fragment key={item.id}>
                    {renderItem(item, isActive)}
                  </React.Fragment>
                );
              }

              // Default item rendering - indent children like NavigationMenu
              return (
                <div
                  key={item.id}
                  className={
                    group.title && group.collapsible !== false ? "ml-3" : ""
                  }
                >
                  <SidebarItem
                    item={item}
                    isActive={isActive}
                    onClick={() => handleItemClick(item as T)}
                    onClose={
                      onItemClose
                        ? (e) => handleItemClose(item as T, e)
                        : undefined
                    }
                    canClose={!!onItemClose}
                    theme={theme}
                  />
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// Wrap generic component with React.memo — cast needed for generic support
const SidebarGroup = React.memo(SidebarGroupInner) as typeof SidebarGroupInner;

export default SidebarGroup;
