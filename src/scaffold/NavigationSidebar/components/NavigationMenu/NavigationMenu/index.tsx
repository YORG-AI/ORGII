import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
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
  }) => {
    const { t } = useTranslation();

    const itemsKey = useMemo(
      () => JSON.stringify(items.map((item) => item.key)),
      [items]
    );
    const submenuKeysKey = useMemo(
      () =>
        JSON.stringify(
          items.map((item) => [
            item.key,
            item.children?.map((child) => child.key) ?? [],
          ])
        ),
      [items]
    );
    const defaultOpenKeysKey = useMemo(
      () => JSON.stringify(defaultOpenKeys),
      [defaultOpenKeys]
    );
    const selectedKeysKey = useMemo(
      () => JSON.stringify(selectedKeys),
      [selectedKeys]
    );

    const [openSubmenus, setOpenSubmenus] = useState<string[]>(defaultOpenKeys);

    const toggleSubmenu = useCallback(
      (key: string) => {
        const open = !openSubmenus.includes(key);
        setOpenSubmenus(
          open
            ? [...openSubmenus, key]
            : openSubmenus.filter((keyItem) => keyItem !== key)
        );
        // Keep cross-component navigation outside the state updater. React can
        // replay updater functions, which previously emitted duplicate opens
        // and could restore a drill-down after its Back action closed it.
        onSubmenuOpenChange?.(key, open);
      },
      [onSubmenuOpenChange, openSubmenus]
    );

    const isSubmenuSelected = useCallback(
      (item: NavigationMenuItem): boolean => {
        if (!item.children) return false;
        return item.children.some((child) => selectedKeys.includes(child.key));
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedKeysKey is the semantic content clock for selectedKeys; same-content array allocations must not churn this callback's identity, which gates the expansion effect below
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
      // eslint-disable-next-line react-hooks/exhaustive-deps -- these content keys own reset timing; depending on defaultOpenKeys identity would reset user-expanded state for equal parent arrays
    }, [itemsKey, defaultOpenKeysKey]);

    useEffect(() => {
      items.forEach((item) => {
        if (item.children && isSubmenuSelected(item)) {
          setOpenSubmenus((prev) => {
            if (prev.includes(item.key)) return prev;
            // Selected-child expansion is internal presentation state, not a
            // user navigation request. Reporting it as an explicit open can
            // undo a parent layer's Back action when the child stays selected.
            return [...prev, item.key];
          });
        }
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps -- only `items` is omitted: submenuKeysKey encodes every key this depth-1 pass reads (top-level keys plus each item's direct child keys), so equivalent menu arrays must not rerun it. isSubmenuSelected is listed rather than omitted because it is memoized on selectedKeysKey, which is already a dependency. NOTE: if this pass is ever made recursive, submenuKeysKey stops covering its reads and must be deepened with it.
    }, [submenuKeysKey, selectedKeysKey, isSubmenuSelected]);

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

        // `AnyIcon` handles every remaining shape, including `""` (= no icon).
        if (!icon) return null;

        return (
          <AnyIcon
            icon={icon}
            size={14}
            className={`flex-shrink-0 ${colorClass}`}
          />
        );
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
      function renderMenuItem(item: NavigationMenuItem, isChild = false) {
        return renderNavigationMenuItem({
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
        });
      },
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
