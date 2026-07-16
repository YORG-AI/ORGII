import { ChevronDown, ChevronRight } from "lucide-react";
import React, { useCallback } from "react";

import { useImmediateCursorReset } from "@src/hooks/ui/useImmediateCursorReset";
import { ReferenceDragGhost } from "@src/shared/dnd/ReferenceDragGhost";

import type { NavigationMenuItem } from "../config";
import { NavigationMenuRowAccessorySlot } from "./RowAccessorySlot";
import { NavigationMenuRowActionButton } from "./RowActionButton";
import type {
  NavigationMenuIconRenderer,
  NavigationMenuItemRenderer,
  NavigationMenuRowActionClickHandler,
  NavigationMenuRowMouseEnterHandler,
} from "./types";
import { useNavItemDrag } from "./useNavItemDrag";

interface NavigationMenuParentRowProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children"
> {
  item: NavigationMenuItem;
  isChild: boolean;
  isOpen: boolean;
  submenuSelected: boolean;
  collapsed: boolean;
  t: (key: string) => string;
  renderIcon: NavigationMenuIconRenderer;
  renderMenuItem: NavigationMenuItemRenderer;
  onMenuItemClick: (key: string, item: NavigationMenuItem) => void;
  onMenuItemContextMenu?: (
    event: React.MouseEvent,
    key: string,
    item: NavigationMenuItem
  ) => void;
  onRowMouseEnter: NavigationMenuRowMouseEnterHandler;
  onToggleSubmenu: (key: string) => void;
  compactRows: boolean;
}

export const NavigationMenuParentRow = React.forwardRef<
  HTMLDivElement,
  NavigationMenuParentRowProps
>(function NavigationMenuParentRow(
  {
    item,
    isChild,
    isOpen,
    submenuSelected,
    collapsed,
    t,
    renderIcon,
    renderMenuItem,
    onMenuItemClick,
    onMenuItemContextMenu,
    onRowMouseEnter,
    onToggleSubmenu,
    compactRows,
    onMouseEnter,
    onMouseLeave,
    ...rootProps
  },
  ref
): React.ReactElement {
  const iconColor = submenuSelected ? "text-primary-6" : "text-text-1";
  const { dragHandlers, dragState } = useNavItemDrag(item);
  const {
    cursorReset,
    markClicked,
    resetCursor: resetImmediateCursor,
  } = useImmediateCursorReset(submenuSelected, !item.disabled);

  const handleRootMouseLeave = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      resetImmediateCursor();
      onMouseLeave?.(event);
    },
    [resetImmediateCursor, onMouseLeave]
  );
  const rowHeightClass = compactRows ? "h-8" : "min-h-[36px]";

  return (
    <div
      {...rootProps}
      {...dragHandlers}
      ref={ref}
      className={`mb-1 ${rootProps.className ?? ""} ${item.dragPayload ? "cursor-grab active:cursor-grabbing" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={handleRootMouseLeave}
      onContextMenu={
        onMenuItemContextMenu
          ? (event: React.MouseEvent) =>
              onMenuItemContextMenu(event, item.key, item)
          : undefined
      }
    >
      {dragState && <ReferenceDragGhost dragState={dragState} />}
      <div
        data-testid={item.dataTestId}
        className={`group flex ${rowHeightClass} items-center justify-between rounded-lg transition-colors duration-150 ${
          isChild ? "pl-5 pr-2" : "px-2"
        } ${submenuSelected ? "cursor-default bg-fill-2 text-primary-6" : cursorReset ? "cursor-default text-text-1 hover:bg-fill-2" : "cursor-pointer text-text-1 hover:bg-fill-2"}`}
        onClick={() => {
          if (item.disabled) return;
          markClicked();
          onMenuItemClick(item.key, item);
        }}
        onMouseEnter={(event: React.MouseEvent) =>
          onRowMouseEnter(event, item.routePath)
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {renderLeadingIcon({
            item,
            iconColor,
            renderIcon,
          })}
          {!collapsed && (
            <div className="flex min-w-0 flex-1 flex-col gap-0">
              <span
                className={`truncate text-[13px] ${
                  submenuSelected ? "font-medium text-primary-6" : "text-text-1"
                }`}
              >
                {item.label}
              </span>
              {item.subtitle && (
                <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-text-3">
                  {item.subtitle}
                </span>
              )}
            </div>
          )}
        </div>
        {!collapsed && (
          <span className="ml-1 inline-flex flex-shrink-0 items-center gap-1.5 leading-none">
            {item.trailingElement && (
              <span className="inline-flex flex-shrink-0 items-center leading-none">
                {item.trailingElement}
              </span>
            )}
            <button
              type="button"
              aria-label={isOpen ? t("actions.collapse") : t("actions.expand")}
              title={isOpen ? t("actions.collapse") : t("actions.expand")}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-3 transition-colors duration-150 hover:bg-fill-2 hover:text-text-1 focus:outline-none"
              data-testid={`${item.key}-session-tree-toggle`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleSubmenu(item.key);
              }}
            >
              <ChevronDown
                size={12}
                strokeWidth={2}
                className={`transition-transform duration-200 ${
                  isOpen ? "rotate-180" : ""
                } ${submenuSelected ? "text-primary-6" : "text-text-2"}`}
              />
            </button>
          </span>
        )}
      </div>

      {isOpen && !collapsed && item.children && (
        <div className="mt-1 space-y-1">
          {item.children.map((child) => (
            <React.Fragment key={child.key}>
              {renderMenuItem(child, true)}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
});

interface NavigationMenuLeafRowProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children"
> {
  item: NavigationMenuItem;
  isChild: boolean;
  isSelected: boolean;
  collapsed: boolean;
  t: (key: string) => string;
  renderIcon: NavigationMenuIconRenderer;
  onMenuItemClick: (key: string, item: NavigationMenuItem) => void;
  onMenuItemContextMenu?: (
    event: React.MouseEvent,
    key: string,
    item: NavigationMenuItem
  ) => void;
  onRowMouseEnter: NavigationMenuRowMouseEnterHandler;
  onRowActionClick: NavigationMenuRowActionClickHandler;
  compactRows: boolean;
}

export const NavigationMenuLeafRow = React.forwardRef<
  HTMLDivElement,
  NavigationMenuLeafRowProps
>(function NavigationMenuLeafRow(
  {
    item,
    isChild,
    isSelected,
    collapsed,
    t,
    renderIcon,
    onMenuItemClick,
    onMenuItemContextMenu,
    onRowMouseEnter,
    onRowActionClick,
    compactRows,
    onMouseEnter,
    onMouseLeave,
    ...rootProps
  },
  ref
): React.ReactElement {
  const isSecondaryTone = item.visualTone === "secondary";
  const iconColor = item.disabled
    ? isSecondaryTone
      ? "text-text-2"
      : "text-text-3"
    : isSelected
      ? "text-primary-6"
      : isSecondaryTone
        ? "text-text-2"
        : "text-text-1";

  const { dragHandlers, dragState } = useNavItemDrag(item);
  const {
    cursorReset,
    markClicked,
    resetCursor: resetImmediateCursor,
  } = useImmediateCursorReset(isSelected, !item.disabled);
  const showIndentGuide = Boolean(item.showIndentGuide);

  const handleRootMouseLeave = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      resetImmediateCursor();
      onMouseLeave?.(event);
    },
    [resetImmediateCursor, onMouseLeave]
  );
  const rowHeightClass = compactRows ? "h-8" : "min-h-[36px]";

  return (
    <div
      {...rootProps}
      {...dragHandlers}
      ref={ref}
      className={`${rootProps.className ?? ""} ${showIndentGuide ? "relative pl-4" : ""} ${item.dragPayload ? "cursor-grab active:cursor-grabbing" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={handleRootMouseLeave}
      onContextMenu={(event: React.MouseEvent) =>
        onMenuItemContextMenu?.(event, item.key, item)
      }
    >
      {dragState && <ReferenceDragGhost dragState={dragState} />}
      {showIndentGuide && (
        <span className="pointer-events-none absolute -bottom-0.5 -top-0.5 left-2 w-px bg-border-3" />
      )}
      <div
        data-testid={item.dataTestId}
        className={`group flex ${rowHeightClass} items-center justify-between overflow-hidden rounded-lg transition-colors duration-150 ${
          isChild ? "pl-5 pr-2" : "px-2"
        } ${item.subtitle ? "py-1.5" : ""} ${
          item.disabled
            ? isSecondaryTone
              ? "cursor-default text-text-2 opacity-60"
              : "cursor-default text-text-3 opacity-60"
            : isSelected
              ? "cursor-default bg-fill-2 text-primary-6"
              : isSecondaryTone
                ? `${cursorReset ? "cursor-default" : "cursor-pointer"} text-text-2 hover:bg-fill-2 hover:text-text-1`
                : `${cursorReset ? "cursor-default" : "cursor-pointer"} text-text-1 hover:bg-fill-2`
        }`}
        onClick={(event: React.MouseEvent) => {
          if (item.disabled) return;
          if (isSelected && onMenuItemContextMenu) {
            onMenuItemContextMenu(event, item.key, item);
            return;
          }
          markClicked();
          onMenuItemClick(item.key, item);
        }}
        onMouseEnter={(event: React.MouseEvent) =>
          onRowMouseEnter(event, item.routePath)
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {renderLeadingIcon({
            item,
            iconColor,
            renderIcon,
          })}
          {!collapsed && (
            <div className="flex min-w-0 flex-1 flex-col gap-0">
              <span
                className={`min-w-0 truncate text-[13px] ${
                  item.disabled
                    ? isSecondaryTone
                      ? "text-text-2"
                      : "text-text-3"
                    : isSelected
                      ? "font-medium text-primary-6"
                      : isSecondaryTone
                        ? "text-text-2"
                        : "text-text-1"
                }`}
              >
                {item.label}
              </span>
              {item.subtitle && (
                <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-text-3">
                  {item.subtitle}
                </span>
              )}
            </div>
          )}
        </div>
        {renderLeafRowAccessory({
          item,
          isSelected,
          collapsed,
          t,
          onMenuItemContextMenu,
          onRowActionClick,
        })}
      </div>
    </div>
  );
});

interface RenderLeadingIconArgs {
  item: NavigationMenuItem;
  iconColor: string;
  renderIcon: NavigationMenuIconRenderer;
}

function renderLeadingIcon({
  item,
  iconColor,
  renderIcon,
}: RenderLeadingIconArgs): React.ReactNode {
  const icon = renderIcon(
    item.icon,
    item.iconName,
    iconColor,
    item.iconElement
  );
  const action = item.iconAction;
  if (!action) return icon;

  const ActionIcon = action.icon ?? ChevronDown;

  return (
    <span className="relative inline-flex h-[14px] w-[14px] flex-shrink-0 items-center justify-center leading-none">
      <span className="inline-flex items-center justify-center leading-none transition-opacity duration-150 group-focus-within:pointer-events-none group-focus-within:opacity-0 group-hover:pointer-events-none group-hover:opacity-0">
        {icon}
      </span>
      <button
        type="button"
        aria-label={action.label}
        title={action.label}
        className={`pointer-events-none absolute left-1/2 top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded opacity-0 transition-[background-color,color,opacity] duration-150 hover:bg-fill-2 hover:text-text-1 focus:pointer-events-auto focus:opacity-100 focus:outline-none group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${
          action.active ? "text-primary-6" : "text-text-3"
        }`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          action.onClick(event);
        }}
      >
        <ActionIcon size={14} strokeWidth={2} />
      </button>
    </span>
  );
}

interface RenderLeafRowAccessoryArgs {
  item: NavigationMenuItem;
  isSelected: boolean;
  collapsed: boolean;
  t: (key: string) => string;
  onMenuItemContextMenu?: (
    event: React.MouseEvent,
    key: string,
    item: NavigationMenuItem
  ) => void;
  onRowActionClick: NavigationMenuRowActionClickHandler;
}

function renderLeafRowAccessory({
  item,
  isSelected,
  collapsed,
  t,
  onMenuItemContextMenu,
  onRowActionClick,
}: RenderLeafRowAccessoryArgs): React.ReactNode {
  if (collapsed) return null;

  if (item.showMoreActions) {
    return (
      <NavigationMenuRowAccessorySlot
        workingIndicatorContent={item.workingIndicator}
        persistentContent={item.trailingElement}
        hoverContent={
          item.shortcut ? (
            <span className="max-w-[4rem] truncate text-[11px] text-text-2">
              {item.shortcut}
            </span>
          ) : undefined
        }
        actionContent={renderRowActions({
          item,
          t,
          onMenuItemContextMenu,
          onRowActionClick,
        })}
      />
    );
  }

  if (
    !item.shortcut &&
    !item.trailingElement &&
    !item.workingIndicator &&
    !item.showDrillDownIndicator
  ) {
    return null;
  }

  return (
    <NavigationMenuRowAccessorySlot
      workingIndicatorContent={item.workingIndicator}
      persistentContent={
        <>
          {item.trailingElement}
          {item.showDrillDownIndicator && (
            <ChevronRight
              size={13}
              strokeWidth={2}
              className={isSelected ? "text-primary-6" : "text-text-3"}
            />
          )}
        </>
      }
      hoverContent={
        item.shortcut ? (
          <span className="max-w-[4.5rem] truncate text-[11px] text-text-3">
            {item.shortcut}
          </span>
        ) : undefined
      }
    />
  );
}

interface RenderRowActionsArgs {
  item: NavigationMenuItem;
  t: (key: string) => string;
  onMenuItemContextMenu?: (
    event: React.MouseEvent,
    key: string,
    item: NavigationMenuItem
  ) => void;
  onRowActionClick: NavigationMenuRowActionClickHandler;
}

function renderRowActions({
  item,
  t,
  onMenuItemContextMenu,
  onRowActionClick,
}: RenderRowActionsArgs): React.ReactNode {
  if (item.rowActions?.length) {
    return item.rowActions.map((action, actionIndex) => (
      <NavigationMenuRowActionButton
        key={`${action.label}:${actionIndex}`}
        icon={action.icon}
        label={action.label}
        active={action.active}
        onClick={action.onClick}
      />
    ));
  }

  if (!onMenuItemContextMenu && !item.onRowActionClick) return undefined;

  return (
    <NavigationMenuRowActionButton
      icon={item.rowActionIcon}
      label={item.rowActionLabel ?? t("actions.more")}
      onClick={(event) => onRowActionClick(event, item)}
    />
  );
}
