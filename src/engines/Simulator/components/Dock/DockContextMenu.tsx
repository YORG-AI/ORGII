/**
 * DockContextMenu Component
 *
 * Context menu that appears when hovering on dock items.
 * Provides options for "Switch to" and "Split view" actions.
 * Uses Glass for modern glass aesthetic.
 */
// ============================================
// Menu Item Configuration
// ============================================
import React, { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Glass from "@src/components/Glass";
import type { IconSvgElement } from "@src/icons";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { AppType } from "../../types/appTypes";
import { WINDOW_ICONS } from "../../types/windowTypes";
import { DockApp } from "./config";

// Types

export interface DockContextMenuProps {
  /** Whether the menu is visible */
  visible: boolean;
  /** Position of the menu */
  position: { x: number; y: number };
  /** The app item that was clicked */
  targetApp: DockApp | null;
  /** Current active app type */
  activeAppType?: AppType;
  /** Callback when "Switch to" is selected */
  onSwitchTo?: (appId: string) => void;
  /** Callback to close the menu */
  onClose?: () => void;
  /** Callback when mouse enters the menu */
  onMouseEnter?: () => void;
  /** Callback when mouse leaves the menu */
  onMouseLeave?: () => void;
}

// ============================================

// ============================================

interface MenuItem {
  id: string;
  label: string;
  icon: IconSvgElement;
  action: "switch";
}

const MENU_ITEMS: MenuItem[] = [
  {
    id: "switch",
    label: "switchTo",
    icon: WINDOW_ICONS.switchTo,
    action: "switch",
  },
];

// ============================================
// Component
// ============================================

export const DockContextMenu: React.FC<DockContextMenuProps> = ({
  visible,
  position,
  targetApp,
  activeAppType,
  onSwitchTo,
  onClose,
  onMouseEnter,
  onMouseLeave,
}) => {
  const { t } = useTranslation("sessions");
  // Use callback ref to adjust position directly on DOM without setState
  const menuCallbackRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !visible) return;

      const rect = node.getBoundingClientRect();
      const { width: viewportWidth } = getViewportSize();

      let newX = position.x;
      let newY = position.y;

      // Center horizontally on the position
      newX = position.x - rect.width / 2;

      // Adjust horizontal position to stay in viewport
      if (newX + rect.width > viewportWidth - 10) {
        newX = viewportWidth - rect.width - 10;
      }
      if (newX < 10) newX = 10;

      // Position above click point
      const menuHeight = rect.height;
      newY = position.y - menuHeight - 10;

      // If not enough space above, position below
      if (newY < 10) {
        newY = position.y + 60; // Below the dock item
      }

      // Apply position directly to DOM
      node.style.left = `${newX}px`;
      node.style.top = `${newY}px`;
    },
    [visible, position]
  );

  // Combined ref for both callback and regular ref access
  const menuRef = useRef<HTMLDivElement | null>(null);
  const setMenuRef = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      menuCallbackRef(node);
    },
    [menuCallbackRef]
  );

  // Close menu when clicking outside or pressing Escape
  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current && !menuRef.current.contains(target)) {
        onClose?.();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };

    // Small delay to prevent immediate close from the click that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);

    document.addEventListener("keydown", handleEscape);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [visible, onClose]);

  const handleItemClick = useCallback(
    (item: MenuItem) => {
      if (!targetApp) return;

      if (item.action === "switch") {
        onSwitchTo?.(targetApp.id);
      }

      onClose?.();
    },
    [targetApp, onSwitchTo, onClose]
  );

  if (!visible || !targetApp) return null;

  const isSameAsActive = targetApp.id === activeAppType;

  return (
    <Glass
      material="thin"
      ref={setMenuRef}
      radius={12}
      className="animate-in fade-in zoom-in-95 fixed z-100 min-w-[180px] p-1"
      style={{
        left: position.x,
        top: position.y,
        boxShadow: "0 12px 48px rgba(0, 0, 0, 0.25)",
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Menu Items */}
      <div className="space-y-0.5">
        {MENU_ITEMS.map((item) => {
          const isDisabled = item.action === "switch" && isSameAsActive;

          return (
            <React.Fragment key={item.id}>
              <button
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-all ${
                  isDisabled
                    ? "cursor-not-allowed text-text-3"
                    : "text-text-1 hover:bg-[rgba(255,255,255,0.4)]"
                }`}
                onClick={() => !isDisabled && handleItemClick(item)}
                disabled={isDisabled}
              >
                <AnyIcon
                  icon={item.icon}
                  size={14}
                  className={isDisabled ? "text-text-3" : "text-text-2"}
                />
                <span className="flex-1">
                  {t(`simulator.dock.${item.label}`)}
                </span>
                {item.action === "switch" && isSameAsActive && (
                  <span className="text-xs text-text-3">
                    {t("simulator.dock.current")}
                  </span>
                )}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </Glass>
  );
};

export default DockContextMenu;
