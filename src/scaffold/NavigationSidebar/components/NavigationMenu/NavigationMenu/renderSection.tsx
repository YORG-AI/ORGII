import type React from "react";

import type { NavigationMenuItem } from "../config";
import {
  NavigationMenuLeafRow,
  NavigationMenuParentRow,
} from "./NavigationMenuRow";
import type {
  NavigationMenuIconRenderer,
  NavigationMenuItemRenderer,
  NavigationMenuProps,
  NavigationMenuRowActionClickHandler,
  NavigationMenuRowMouseEnterHandler,
} from "./types";

interface RenderNavigationMenuItemArgs {
  item: NavigationMenuItem;
  isChild: boolean;
  selectedKeys: string[];
  openSubmenus: string[];
  collapsed: boolean;
  t: (key: string) => string;
  renderMenuItemWrapper?: NavigationMenuProps["renderMenuItemWrapper"];
  renderIcon: NavigationMenuIconRenderer;
  renderMenuItem: NavigationMenuItemRenderer;
  onMenuItemClick: NavigationMenuProps["onMenuItemClick"];
  onMenuItemContextMenu?: NavigationMenuProps["onMenuItemContextMenu"];
  onRowMouseEnter: NavigationMenuRowMouseEnterHandler;
  onRowActionClick: NavigationMenuRowActionClickHandler;
  onToggleSubmenu: (key: string) => void;
  compactRows: boolean;
}

export function renderNavigationMenuItem({
  item,
  isChild,
  selectedKeys,
  openSubmenus,
  collapsed,
  t,
  renderMenuItemWrapper,
  renderIcon,
  renderMenuItem,
  onMenuItemClick,
  onMenuItemContextMenu,
  onRowMouseEnter,
  onRowActionClick,
  onToggleSubmenu,
  compactRows,
}: RenderNavigationMenuItemArgs): React.ReactElement {
  const hasChildren = item.children && item.children.length > 0;
  const isSelected = selectedKeys.includes(item.key);
  const isOpen = openSubmenus.includes(item.key);
  const submenuSelected = Boolean(hasChildren && isSelected);

  const node = hasChildren ? (
    <NavigationMenuParentRow
      item={item}
      isChild={isChild}
      isOpen={isOpen}
      submenuSelected={submenuSelected}
      collapsed={collapsed}
      t={t}
      renderIcon={renderIcon}
      renderMenuItem={renderMenuItem}
      onMenuItemContextMenu={onMenuItemContextMenu}
      onRowMouseEnter={onRowMouseEnter}
      onRowActionClick={onRowActionClick}
      onToggleSubmenu={onToggleSubmenu}
      compactRows={compactRows}
    />
  ) : (
    <NavigationMenuLeafRow
      item={item}
      isChild={isChild}
      isSelected={isSelected}
      collapsed={collapsed}
      t={t}
      renderIcon={renderIcon}
      onMenuItemClick={onMenuItemClick}
      onMenuItemContextMenu={onMenuItemContextMenu}
      onRowMouseEnter={onRowMouseEnter}
      onRowActionClick={onRowActionClick}
      compactRows={compactRows}
    />
  );

  return renderMenuItemWrapper ? renderMenuItemWrapper(item, node) : node;
}
