/**
 * SidebarItem
 *
 * Single item component for sidebar lists.
 * Styled to match NavigationMenu for consistency.
 */
import React, { useMemo } from "react";

import type { SidebarItemProps } from "../types";
import { renderSidebarIcon } from "../utils/renderIcon";

const SidebarItem: React.FC<SidebarItemProps> = ({
  item,
  isActive = false,
  onClick,
  onClose,
  canClose = true,
  theme,
  className = "",
}) => {
  const isPrivateTab = Boolean(item.metadata?.isPrivate);
  const canSecondaryClickClose = Boolean(canClose && onClose);

  const textStyle = useMemo(() => {
    if (!theme) return undefined;
    return {
      color: isActive ? theme.foreground : `${theme.foreground}80`,
    };
  }, [theme, isActive]);

  const iconClasses = theme
    ? ""
    : isActive
      ? isPrivateTab
        ? "text-warning-6"
        : "text-text-1"
      : "text-text-1";

  const textClasses = theme
    ? ""
    : isActive
      ? isPrivateTab
        ? "font-medium text-warning-6"
        : "text-text-1"
      : "text-text-1";

  const rowStateClasses = isActive
    ? isPrivateTab
      ? "bg-bg-1 text-warning-6"
      : "bg-sidebar-selected text-text-1"
    : theme
      ? "text-text-1"
      : "text-text-1 hover:bg-sidebar-selected";

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canSecondaryClickClose || !onClose) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(event);
  };

  const handleAuxClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canSecondaryClickClose || !onClose || event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    onClose(event);
  };

  return (
    <div
      className={`group flex h-8 min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 transition-colors duration-150 ${rowStateClasses} ${className}`}
      onClick={onClick}
      onContextMenu={handleContextMenu}
      onAuxClick={handleAuxClick}
    >
      {(item.icon || (item.metadata?.favicon as string)) && (
        <div className={`shrink-0 ${iconClasses}`} style={textStyle}>
          {renderSidebarIcon(item.icon, {
            faviconUrl: item.metadata?.favicon as string | undefined,
            isLoading: item.metadata?.isLoading as boolean | undefined,
          })}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <span
          className={`block truncate text-[13px] leading-4 ${textClasses}`}
          style={textStyle}
        >
          {item.name}
        </span>
        {item.subtitle && (
          <span
            className="block truncate text-[11px] leading-3 text-text-3"
            style={theme ? { color: `${theme.foreground}60` } : undefined}
          >
            {item.subtitle}
          </span>
        )}
      </div>

      {(item.badge || item.shortcut) && (
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-1">
          {item.badge && (
            <span className="shrink-0 rounded-full bg-danger-6 px-2 py-0.5 text-[10px] font-medium text-white">
              {item.badge}
            </span>
          )}
          {item.shortcut && (
            <span className="shrink-0 text-[11px] whitespace-nowrap text-text-3">
              {item.shortcut}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(SidebarItem);
