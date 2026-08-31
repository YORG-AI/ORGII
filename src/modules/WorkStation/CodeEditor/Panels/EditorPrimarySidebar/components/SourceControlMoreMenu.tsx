/**
 * SourceControlMoreMenu Component
 *
 * "..." button for the Source Control section header that opens a
 * right-aligned web dropdown with git remote operations: Pull, Push, Fetch, Sync.
 *
 * Uses useDropdownEngine + DROPDOWN_CLASSES + createPortal pattern.
 * Button shows primary-6 selected state while dropdown is open.
 * Dropdown is right-aligned to the trigger button.
 */
import React, { memo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  ArrowUpDownIcon,
  CloudUploadIcon,
  EllipsisIcon,
  HugeiconsIcon,
  Refresh04Icon,
} from "@src/icons";
import {
  HEADER_BUTTON,
  PRIMARY_SIDEBAR_HOVER,
} from "@src/modules/WorkStation/shared/tokens";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { PANEL_CONSTANTS } from "../config";

const SOURCE_CONTROL_MENU_KEYS = {
  pull: "sourceControl.pull",
  push: "sourceControl.push",
  fetch: "sourceControl.fetch",
  sync: "sourceControl.sync",
} as const;

// ============================================
// Types
// ============================================

export interface SourceControlMoreMenuProps {
  /** Pull from remote */
  onPull: () => void;
  /** Push to remote */
  onPush: () => void;
  /** Fetch from remote */
  onFetch: () => void;
  /** Sync (pull + push) */
  onSync: () => void;
  /** Publish the current branch by setting its upstream */
  onPublish?: () => void;
  /** Whether the current branch has an upstream tracking branch */
  hasUpstream?: boolean;
  /** Number of commits ahead of remote */
  ahead?: number;
  /** Number of commits behind remote */
  behind?: number;
  /** Whether any operation is currently loading */
  isLoading?: boolean;
  /** Called when the dropdown open state changes */
  onOpenChange?: (isOpen: boolean) => void;
}

// ============================================
// Main Component
// ============================================

export const SourceControlMoreMenu: React.FC<SourceControlMoreMenuProps> = memo(
  ({
    onPull,
    onPush,
    onFetch,
    onSync,
    onPublish,
    hasUpstream = true,
    isLoading = false,
    onOpenChange,
  }) => {
    const { t } = useTranslation();
    const {
      isOpen,
      isPositioned,
      toggle,
      close,
      triggerRef,
      panelRef,
      panelPosition,
    } = useDropdownEngine<HTMLButtonElement>({
      gap: DROPDOWN_PANEL.triggerGapTight,
      placement: "bottom",
      align: "right",
    });

    // Notify parent when open state changes (for forceVisible on actions bar)
    useEffect(() => {
      onOpenChange?.(isOpen);
    }, [isOpen, onOpenChange]);

    const handleItemClick = useCallback(
      (action: () => void) => {
        close();
        action();
      },
      [close]
    );

    // Right-align: anchor dropdown's right edge to trigger's right edge
    const triggerRightEdge = panelPosition.left + panelPosition.width;
    const viewportWidth =
      typeof window !== "undefined" ? getViewportSize().width : 0;

    return (
      <>
        {/* Trigger button - shows primary-6 selected state when open */}
        <button
          ref={triggerRef}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
          className={
            isOpen ? HEADER_BUTTON.active : HEADER_BUTTON.actionTreeRow
          }
          title={t("tooltips.moreActions", "More Actions...")}
          disabled={isLoading}
        >
          <HugeiconsIcon
            icon={EllipsisIcon}
            data-icon="ellipsis"
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
          />
        </button>

        {/* Right-aligned dropdown menu */}
        {isOpen &&
          isPositioned &&
          createPortal(
            <DropdownPanel
              ref={panelRef}
              className={`${DROPDOWN_WIDTHS.sidebarMenuClass} ${DROPDOWN_PANEL.paddingClass}`}
              animated={false}
              maxHeight="none"
              style={{
                position: "fixed",
                top: panelPosition.top,
                right: viewportWidth - triggerRightEdge,
                zIndex: DROPDOWN_PANEL.zIndex,
              }}
            >
              <div className={DROPDOWN_CLASSES.itemsColumn}>
                {hasUpstream ? (
                  <>
                    <div
                      className={`${DROPDOWN_CLASSES.item} ${PRIMARY_SIDEBAR_HOVER.row}`}
                      onClick={() => handleItemClick(onPull)}
                    >
                      <HugeiconsIcon
                        icon={ArrowDown02Icon}
                        data-icon="arrow-down"
                        size={DROPDOWN_ITEM.iconSize}
                        className="shrink-0"
                      />
                      {t(SOURCE_CONTROL_MENU_KEYS.pull)}
                    </div>
                    <div
                      className={`${DROPDOWN_CLASSES.item} ${PRIMARY_SIDEBAR_HOVER.row}`}
                      onClick={() => handleItemClick(onPush)}
                    >
                      <HugeiconsIcon
                        icon={ArrowUp02Icon}
                        data-icon="arrow-up"
                        size={DROPDOWN_ITEM.iconSize}
                        className="shrink-0"
                      />
                      {t(SOURCE_CONTROL_MENU_KEYS.push)}
                    </div>
                    <div
                      className={`${DROPDOWN_CLASSES.item} ${PRIMARY_SIDEBAR_HOVER.row}`}
                      onClick={() => handleItemClick(onFetch)}
                    >
                      <HugeiconsIcon
                        icon={Refresh04Icon}
                        data-icon="refresh-cw"
                        size={DROPDOWN_ITEM.iconSize}
                        className="shrink-0"
                      />
                      {t(SOURCE_CONTROL_MENU_KEYS.fetch)}
                    </div>
                    <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                    <div
                      className={`${DROPDOWN_CLASSES.item} ${PRIMARY_SIDEBAR_HOVER.row}`}
                      onClick={() => handleItemClick(onSync)}
                    >
                      <HugeiconsIcon
                        icon={ArrowUpDownIcon}
                        data-icon="arrow-up-down"
                        size={DROPDOWN_ITEM.iconSize}
                        className="shrink-0"
                      />
                      {t(SOURCE_CONTROL_MENU_KEYS.sync)}
                    </div>
                  </>
                ) : (
                  <div
                    className={`${DROPDOWN_CLASSES.item} ${PRIMARY_SIDEBAR_HOVER.row}`}
                    onClick={() => handleItemClick(onPublish ?? onSync)}
                  >
                    <HugeiconsIcon
                      icon={CloudUploadIcon}
                      data-icon="cloud-upload"
                      size={DROPDOWN_ITEM.iconSize}
                      className="shrink-0"
                    />
                    {t("common:actions.publish")}
                  </div>
                )}
              </div>
            </DropdownPanel>,
            document.body
          )}
      </>
    );
  }
);

SourceControlMoreMenu.displayName = "SourceControlMoreMenu";

export default SourceControlMoreMenu;
