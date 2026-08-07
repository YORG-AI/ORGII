import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { preloadRouteByPath } from "@src/router/lazy/preload";

import type { NavigationMenuItem } from "../config";
import { renderNavigationMenuItem } from "./renderSection";
import type { NavigationMenuProps } from "./types";

const NavigationMenu: React.FC<NavigationMenuProps> = React.memo(
  ({
    items,
    selectedKeys,
    onMenuItemClick,
    onSubmenuOpenChange,
    onMenuItemContextMenu,
    renderMenuItemWrapper,
    collapsed = false,
    defaultOpenKeys = [],
    compactRows = false,
  }) => {
    const { t } = useTranslation();

    const itemsKey = useMemo(
      () => items.map((item) => item.key).join(","),
      [items]
    );
    const defaultOpenKeysKey = useMemo(
      () => defaultOpenKeys.join(","),
      [defaultOpenKeys]
    );
    const selectedKeysKey = useMemo(
      () => selectedKeys.join(","),
      [selectedKeys]
    );

    const [openSubmenus, setOpenSubmenus] = useState<string[]>(defaultOpenKeys);

    const toggleSubmenu = useCallback(
      (key: string) => {
        setOpenSubmenus((prev) => {
          const open = !prev.includes(key);
          onSubmenuOpenChange?.(key, open);
          return open
            ? [...prev, key]
            : prev.filter((keyItem) => keyItem !== key);
        });
      },
      [onSubmenuOpenChange]
    );

    const isSubmenuSelected = useCallback(
      (item: NavigationMenuItem): boolean => {
        if (!item.children) return false;
        return item.children.some((child) => selectedKeys.includes(child.key));
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [selectedKeysKey]
    );

    const prevKeysRef = useRef({ itemsKey: "", defaultOpenKeysKey: "" });

    useEffect(() => {
      const keysChanged =
        prevKeysRef.current.itemsKey !== itemsKey ||
        prevKeysRef.current.defaultOpenKeysKey !== defaultOpenKeysKey;

      if (keysChanged) {
        prevKeysRef.current = { itemsKey, defaultOpenKeysKey };
        setOpenSubmenus(defaultOpenKeys);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [itemsKey, defaultOpenKeysKey]);

    useEffect(() => {
      items.forEach((item) => {
        if (item.children && isSubmenuSelected(item)) {
          setOpenSubmenus((prev) => {
            if (prev.includes(item.key)) return prev;
            onSubmenuOpenChange?.(item.key, true);
            return [...prev, item.key];
          });
        }
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [itemsKey, onSubmenuOpenChange, selectedKeysKey]);

    const renderIcon = useCallback(
      (
        icon: NavigationMenuItem["icon"],
        _iconName: string | undefined,
        colorClass: string,
        iconElement?: NavigationMenuItem["iconElement"]
      ) => {
        if (iconElement) {
          return (
            <span
              className={`inline-flex flex-shrink-0 items-center leading-none ${colorClass}`}
            >
              {iconElement}
            </span>
          );
        }

        if (!icon) return null;

        if (typeof icon === "string") {
          return (
            <i className={`${icon} flex-shrink-0 text-[14px] ${colorClass}`} />
          );
        }

        return React.createElement(icon, {
          size: 14,
          strokeWidth: 2,
          className: `flex-shrink-0 ${colorClass}`,
        });
      },
      []
    );

    const handleRowMouseEnter = useCallback(
      (_event: React.MouseEvent, routePath?: string) => {
        if (routePath) {
          preloadRouteByPath(routePath);
        }
      },
      []
    );

    const handleRowActionClick = useCallback(
      (
        event: React.MouseEvent<HTMLButtonElement>,
        item: NavigationMenuItem
      ) => {
        event.preventDefault();
        event.stopPropagation();
        if (item.onRowActionClick) {
          item.onRowActionClick(event);
          return;
        }
        onMenuItemContextMenu?.(event, item.key, item);
      },
      [onMenuItemContextMenu]
    );

    const renderMenuItem = useCallback(
      (item: NavigationMenuItem, isChild = false) =>
        renderNavigationMenuItem({
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
          onRowMouseEnter: handleRowMouseEnter,
          onRowActionClick: handleRowActionClick,
          onToggleSubmenu: toggleSubmenu,
          compactRows,
        }),
      [
        selectedKeys,
        openSubmenus,
        collapsed,
        t,
        renderMenuItemWrapper,
        renderIcon,
        onMenuItemClick,
        onMenuItemContextMenu,
        handleRowMouseEnter,
        handleRowActionClick,
        toggleSubmenu,
        compactRows,
      ]
    );

    return (
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <React.Fragment key={item.key}>{renderMenuItem(item)}</React.Fragment>
        ))}
      </div>
    );
  }
);

NavigationMenu.displayName = "NavigationMenu";

export type { NavigationMenuProps } from "./types";
export default NavigationMenu;
