import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { preloadRouteByPath } from "@src/router/lazy/preload";

import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../../HoverAnimatedIcon";
import type { NavigationMenuItem } from "../config";
import { renderNavigationMenuItem } from "./renderSection";
import type { NavigationMenuProps } from "./types";

const NavigationMenu: React.FC<NavigationMenuProps> = React.memo(
  ({
    items,
    selectedKeys,
    onMenuItemClick,
    onMenuItemContextMenu,
    renderMenuItemWrapper,
    collapsed = false,
    defaultOpenKeys = [],
    enableHoverIconAnimation = false,
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

    const toggleSubmenu = useCallback((key: string) => {
      setOpenSubmenus((prev) =>
        prev.includes(key)
          ? prev.filter((keyItem) => keyItem !== key)
          : [...prev, key]
      );
    }, []);

    const isSubmenuSelected = useCallback(
      (item: NavigationMenuItem): boolean => {
        if (!item.children) return false;
        return item.children.some(
          (child) =>
            selectedKeys.includes(child.key) || isSubmenuSelected(child)
        );
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
      const selectedAncestors: string[] = [];
      const collectSelectedAncestors = (
        nodes: readonly NavigationMenuItem[]
      ) => {
        for (const item of nodes) {
          if (item.children && isSubmenuSelected(item)) {
            selectedAncestors.push(item.key);
            collectSelectedAncestors(item.children);
          }
        }
      };
      collectSelectedAncestors(items);
      if (selectedAncestors.length > 0) {
        setOpenSubmenus((prev) =>
          Array.from(new Set([...prev, ...selectedAncestors]))
        );
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [itemsKey, selectedKeysKey]);

    const renderIcon = useCallback(
      (
        icon: NavigationMenuItem["icon"],
        iconName: string | undefined,
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

        if (enableHoverIconAnimation) {
          return (
            <HoverAnimatedIcon
              icon={icon}
              iconName={iconName}
              size={14}
              strokeWidth={2}
              className={`flex-shrink-0 ${colorClass}`}
            />
          );
        }

        return React.createElement(icon, {
          size: 14,
          strokeWidth: 2,
          className: `flex-shrink-0 ${colorClass}`,
        });
      },
      [enableHoverIconAnimation]
    );

    const handleRowMouseEnter = useCallback(
      (event: React.MouseEvent, routePath?: string) => {
        if (enableHoverIconAnimation) {
          triggerIconAnimation(event.currentTarget as HTMLElement);
        }
        if (routePath) {
          preloadRouteByPath(routePath);
        }
      },
      [enableHoverIconAnimation]
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
          isSubmenuSelected,
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
        isSubmenuSelected,
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
