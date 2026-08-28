import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import type { ContextMenuItem } from "@src/types/core/shared";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { SubmenuPanel } from "./SubmenuPanel";
import { getShortcutLabel, matchesContextShortcut } from "./contextMenuUtils";
import "./index.scss";

interface WorkItemContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
  openDirection?: "up" | "down";
}

interface SubmenuState {
  itemId: string;
  position: { x: number; y: number };
}

const WorkItemContextMenu: React.FC<WorkItemContextMenuProps> = ({
  items,
  position,
  onClose,
  openDirection = "down",
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const nestedSubmenuRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<SubmenuState | null>(null);
  const [openNestedSubmenu, setOpenNestedSubmenu] =
    useState<SubmenuState | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();

    let adjustedX = position.x;
    let adjustedY =
      openDirection === "up" ? position.y - rect.height : position.y;

    if (position.x + rect.width > viewportWidth) {
      adjustedX = Math.max(8, viewportWidth - rect.width - 8);
    }

    if (position.y + rect.height > viewportHeight) {
      adjustedY = Math.max(8, viewportHeight - rect.height - 8);
    }

    menu.style.left = `${adjustedX}px`;
    menu.style.top = `${adjustedY}px`;
    menu.style.opacity = "1";
    menu.style.pointerEvents = "auto";
  }, [openDirection, position]);

  useLayoutEffect(() => {
    if (!openSubmenu || !submenuRef.current) return;

    const submenu = submenuRef.current;
    const rect = submenu.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();

    if (rect.right > viewportWidth) {
      const menuRect = menuRef.current?.getBoundingClientRect();
      if (menuRect) {
        submenu.style.left = `${menuRect.left - rect.width - DROPDOWN_PANEL.submenuGap}px`;
      }
    }

    if (rect.bottom > viewportHeight) {
      submenu.style.top = `${viewportHeight - rect.height - 8}px`;
    }
  }, [openSubmenu]);

  useLayoutEffect(() => {
    if (!openNestedSubmenu || !nestedSubmenuRef.current) return;

    const nestedSubmenu = nestedSubmenuRef.current;
    const rect = nestedSubmenu.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();

    if (rect.right > viewportWidth) {
      const submenuRect = submenuRef.current?.getBoundingClientRect();
      if (submenuRect) {
        nestedSubmenu.style.left = `${submenuRect.left - rect.width - DROPDOWN_PANEL.submenuGap}px`;
      }
    }

    if (rect.bottom > viewportHeight) {
      nestedSubmenu.style.top = `${viewportHeight - rect.height - 8}px`;
    }
  }, [openNestedSubmenu]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const clickedInsideMenu = menuRef.current?.contains(target);
      const clickedInsideSubmenu = submenuRef.current?.contains(target);
      const clickedInsideNestedSubmenu =
        nestedSubmenuRef.current?.contains(target);

      if (
        !clickedInsideMenu &&
        !clickedInsideSubmenu &&
        !clickedInsideNestedSubmenu
      ) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  const activeSubmenuItem = openSubmenu
    ? items.find((item) => item.id === openSubmenu.itemId)
    : null;
  const activeNestedSubmenuItem = openNestedSubmenu
    ? activeSubmenuItem?.submenu?.find(
        (item) => item.id === openNestedSubmenu.itemId
      )
    : null;

  const executeMenuItem = useCallback(
    (item: ContextMenuItem) => {
      if (item.disabled || item.divider || item.submenu) return;
      item.action?.();
      onClose();
    },
    [onClose]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (openSubmenu && activeSubmenuItem?.submenu) {
        const numericIndex = Number(event.key);
        if (
          Number.isInteger(numericIndex) &&
          numericIndex >= 1 &&
          numericIndex <= activeSubmenuItem.submenu.length
        ) {
          const submenuItem = activeSubmenuItem.submenu[numericIndex - 1];
          if (!submenuItem.disabled && !submenuItem.divider) {
            event.preventDefault();
            executeMenuItem(submenuItem);
          }
        }
        return;
      }

      const matchingItem = items.find((item) =>
        matchesContextShortcut(item, event)
      );
      if (!matchingItem) return;

      event.preventDefault();
      if (matchingItem.submenu && matchingItem.submenu.length > 0) {
        const button = menuRef.current?.querySelector<HTMLButtonElement>(
          `[data-context-menu-item-id="${matchingItem.id}"]`
        );
        const rect = button?.getBoundingClientRect();
        const menuRect = menuRef.current?.getBoundingClientRect();
        if (rect) {
          setOpenSubmenu({
            itemId: matchingItem.id,
            position: {
              x: (menuRect?.right ?? rect.right) + DROPDOWN_PANEL.submenuGap,
              y: rect.top,
            },
          });
        }
        return;
      }

      executeMenuItem(matchingItem);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeSubmenuItem, executeMenuItem, items, onClose, openSubmenu]);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  const handleItemClick = useCallback(
    (item: ContextMenuItem, event: React.MouseEvent) => {
      event.stopPropagation();
      if (item.disabled || item.divider || item.submenu) return;
      item.action?.();
      onClose();
    },
    [onClose]
  );

  const handleSubmenuItemClick = useCallback(
    (item: ContextMenuItem, event: React.MouseEvent) => {
      event.stopPropagation();
      if (item.disabled || item.divider || item.submenu) return;
      item.action?.();
      onClose();
    },
    [onClose]
  );

  const handleItemMouseEnter = useCallback(
    (item: ContextMenuItem, event: React.MouseEvent) => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }

      if (item.submenu && item.submenu.length > 0) {
        const target = event.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        const menuRect = menuRef.current?.getBoundingClientRect();

        setOpenNestedSubmenu(null);
        setOpenSubmenu({
          itemId: item.id,
          position: {
            x: (menuRect?.right ?? rect.right) + DROPDOWN_PANEL.submenuGap,
            y: rect.top,
          },
        });
      } else {
        setOpenNestedSubmenu(null);
        setOpenSubmenu(null);
      }
    },
    []
  );

  const handleNestedSubmenuMouseEnter = useCallback(
    (item: ContextMenuItem, event: React.MouseEvent) => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }

      if (item.submenu && item.submenu.length > 0) {
        const target = event.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        const submenuRect = submenuRef.current?.getBoundingClientRect();

        setOpenNestedSubmenu({
          itemId: item.id,
          position: {
            x: (submenuRect?.right ?? rect.right) + DROPDOWN_PANEL.submenuGap,
            y: rect.top,
          },
        });
      } else {
        setOpenNestedSubmenu(null);
      }
    },
    []
  );

  const handleSubmenuMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const handleSubmenuMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      setOpenNestedSubmenu(null);
      setOpenSubmenu(null);
    }, 150);
  }, []);

  const handleMenuMouseLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      setOpenNestedSubmenu(null);
      setOpenSubmenu(null);
    }, 150);
  }, []);

  return createPortal(
    <>
      {/* Main Menu */}
      <div
        ref={menuRef}
        className={`work-item-context-menu ${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.fileTreeClass}`}
        style={{
          left: position.x,
          top: position.y,
          opacity: 0,
          pointerEvents: "none",
        }}
        onMouseEnter={handleSubmenuMouseEnter}
        onMouseLeave={handleMenuMouseLeave}
      >
        {items.map((item) => {
          if (item.divider) {
            return (
              <div key={item.id} className="work-item-context-menu__divider" />
            );
          }

          const hasSubmenu = item.submenu && item.submenu.length > 0;
          const isSubmenuOpen = openSubmenu?.itemId === item.id;
          const shortcutLabel = getShortcutLabel(item);

          return (
            <button
              key={item.id}
              type="button"
              data-context-menu-item-id={item.id}
              data-testid={`context-menu-item-${item.id}`}
              className={`work-item-context-menu__item ${DROPDOWN_CLASSES.item} w-full justify-between border-none bg-transparent text-left ${DROPDOWN_CLASSES.itemHover} ${
                item.disabled ? DROPDOWN_CLASSES.itemDisabled : ""
              } ${isSubmenuOpen ? DROPDOWN_CLASSES.itemActive : ""}`}
              onClick={(event) => handleItemClick(item, event)}
              onMouseEnter={(event) => handleItemMouseEnter(item, event)}
              disabled={item.disabled}
            >
              {item.icon && (
                <span
                  className={`work-item-context-menu__icon ${DROPDOWN_ITEM.iconSizeClass} [&_svg]:h-[13px] [&_svg]:w-[13px]`}
                >
                  {item.icon}
                </span>
              )}
              <span className="work-item-context-menu__label">
                {item.label}
              </span>
              {item.secondary && (
                <span className="work-item-context-menu__secondary">
                  {item.secondary}
                </span>
              )}
              {shortcutLabel && (
                <KeyboardShortcut
                  shortcut={shortcutLabel}
                  variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                  className="work-item-context-menu__shortcut"
                />
              )}
              {hasSubmenu && (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
                  size={DROPDOWN_ITEM.iconSize}
                  className="work-item-context-menu__arrow"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* First-level Submenu */}
      {openSubmenu && activeSubmenuItem?.submenu && (
        <SubmenuPanel
          panelRef={submenuRef}
          items={activeSubmenuItem.submenu}
          position={openSubmenu.position}
          activeNestedItemId={openNestedSubmenu?.itemId}
          onItemClick={handleSubmenuItemClick}
          onItemMouseEnter={handleNestedSubmenuMouseEnter}
          onMouseEnter={handleSubmenuMouseEnter}
          onMouseLeave={handleSubmenuMouseLeave}
          showNumericShortcuts
        />
      )}

      {/* Second-level (nested) Submenu */}
      {openNestedSubmenu && activeNestedSubmenuItem?.submenu && (
        <SubmenuPanel
          panelRef={nestedSubmenuRef}
          items={activeNestedSubmenuItem.submenu}
          position={openNestedSubmenu.position}
          onItemClick={handleSubmenuItemClick}
          onItemMouseEnter={() => {}}
          onMouseEnter={handleSubmenuMouseEnter}
          onMouseLeave={handleSubmenuMouseLeave}
          showNumericShortcuts
        />
      )}
    </>,
    document.body
  );
};

export default WorkItemContextMenu;
