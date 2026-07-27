import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  ChevronDown,
  CloudDownload,
  CloudUpload,
  Ellipsis,
  GitCompareArrows,
  RefreshCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DropdownItem } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";

import { StatusBarButton } from "./StatusBarBase";
import { StatusBarTooltip } from "./StatusBarTooltip";

const MENU_ICON_SIZE = DROPDOWN_ITEM.iconSize;

interface GitSyncStatusMenuProps {
  aheadCount: number;
  behindCount: number;
  needsPublish: boolean;
  isSyncBusy: boolean;
  isPublishing: boolean;
  canSyncDisplayedRepo: boolean;
  syncSpinClass: string | undefined;
  syncStatusLabel: string | null;
  onSync: () => void;
  onFetch: () => Promise<void>;
  onPull: () => Promise<void>;
  onRebase: () => Promise<void>;
  onPush: () => Promise<void>;
}

interface GitSyncMenuAction {
  key: string;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  onSelect: () => Promise<void> | void;
}

export const GitSyncStatusMenu: React.FC<GitSyncStatusMenuProps> = memo(
  ({
    aheadCount,
    behindCount,
    needsPublish,
    isSyncBusy,
    isPublishing,
    canSyncDisplayedRepo,
    syncSpinClass,
    syncStatusLabel,
    onSync,
    onFetch,
    onPull,
    onRebase,
    onPush,
  }) => {
    const { t } = useTranslation();
    const {
      close,
      isOpen,
      isPositioned,
      panelPosition,
      panelRef,
      toggle,
      triggerRef,
    } = useDropdownEngine<HTMLDivElement>({
      align: "left",
      gap: DROPDOWN_PANEL.triggerGap,
      placement: "top",
    });
    const [showAllActions, setShowAllActions] = useState(false);

    const handleAction = useCallback(
      (action: () => Promise<void> | void) => {
        close();
        setShowAllActions(false);
        void action();
      },
      [close]
    );

    const handleToggle = useCallback(() => {
      if (isOpen) {
        setShowAllActions(false);
      }
      toggle();
    }, [isOpen, toggle]);

    const actions: GitSyncMenuAction[] = useMemo(
      () => [
        {
          key: "fetch",
          label: "Fetch origin",
          icon: CloudDownload,
          onSelect: onFetch,
        },
        {
          key: "sync",
          label: "Pull then push",
          icon: RefreshCw,
          disabled: needsPublish,
          onSelect: onSync,
        },
        {
          key: "pull",
          label: "Pull",
          icon: ArrowDownToLine,
          disabled: needsPublish,
          onSelect: onPull,
        },
        {
          key: "rebase",
          label: "Pull with rebase",
          icon: GitCompareArrows,
          disabled: needsPublish,
          onSelect: onRebase,
        },
        {
          key: "push",
          label: needsPublish ? "Publish" : "Push",
          icon: needsPublish ? CloudUpload : ArrowUpFromLine,
          onSelect: onPush,
        },
      ],
      [needsPublish, onFetch, onPull, onPush, onRebase, onSync]
    );

    const suggestedAction = useMemo(() => {
      if (needsPublish) return actions.find((action) => action.key === "push");
      if (behindCount > 0 && aheadCount > 0) {
        return actions.find((action) => action.key === "sync");
      }
      if (behindCount > 0)
        return actions.find((action) => action.key === "pull");
      if (aheadCount > 0)
        return actions.find((action) => action.key === "push");
      return actions.find((action) => action.key === "fetch");
    }, [actions, aheadCount, behindCount, needsPublish]);

    const gitActionsLabel = t("workstation.gitActionsTooltip", "Git actions");
    const SuggestedActionIcon = suggestedAction?.icon;

    return (
      <div ref={triggerRef} className="flex h-full">
        <StatusBarTooltip label={gitActionsLabel} disabled={isOpen}>
          <StatusBarButton
            onClick={handleToggle}
            disabled={isSyncBusy || !canSyncDisplayedRepo}
            ariaLabel={gitActionsLabel}
            active={isOpen}
            className="gap-2"
          >
            {needsPublish && !isPublishing ? (
              <CloudUpload size={MENU_ICON_SIZE} className="text-text-1" />
            ) : (
              <RefreshCw
                size={MENU_ICON_SIZE}
                className={`text-text-1 ${syncSpinClass ?? ""}`}
              />
            )}
            {needsPublish && !isPublishing && (
              <span className="font-medium text-text-1">
                {t("git.actions.publish")}
              </span>
            )}
            {isPublishing && (
              <span className="font-medium text-text-1">
                {t("workstation.publishingBranch")}
              </span>
            )}
            {!needsPublish &&
              syncStatusLabel &&
              behindCount === 0 &&
              aheadCount === 0 && (
                <span className="font-medium text-text-1">
                  {syncStatusLabel}
                </span>
              )}
            {!needsPublish && (behindCount > 0 || aheadCount > 0) && (
              <>
                <span className="flex items-center font-medium text-text-1">
                  {behindCount}
                  <ArrowDown size={MENU_ICON_SIZE} />
                </span>
                <span className="flex items-center font-medium text-text-1">
                  {aheadCount}
                  <ArrowUp size={MENU_ICON_SIZE} />
                </span>
              </>
            )}
            <ChevronDown size={12} className="text-text-3" />
          </StatusBarButton>
        </StatusBarTooltip>

        {isOpen &&
          isPositioned &&
          createPortal(
            <div
              ref={panelRef}
              className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.wideMenuClass}`}
              style={{
                position: "fixed",
                top: panelPosition.top,
                bottom: panelPosition.bottom,
                left: panelPosition.left,
                right: panelPosition.right,
              }}
              role="menu"
            >
              <div className={DROPDOWN_CLASSES.itemsColumn}>
                {showAllActions ? (
                  <>
                    {actions.map((action) => {
                      const ActionIcon = action.icon;
                      const disabled =
                        isSyncBusy || !canSyncDisplayedRepo || action.disabled;
                      return (
                        <DropdownItem
                          key={action.key}
                          role="menuitem"
                          fullWidth
                          tabIndex={0}
                          disabled={disabled}
                          onClick={() => handleAction(action.onSelect)}
                          icon={
                            <ActionIcon
                              size={MENU_ICON_SIZE}
                              className="shrink-0 text-text-1"
                            />
                          }
                        >
                          <span className="font-medium">{action.label}</span>
                        </DropdownItem>
                      );
                    })}
                  </>
                ) : (
                  <>
                    {suggestedAction && SuggestedActionIcon && (
                      <DropdownItem
                        role="menuitem"
                        fullWidth
                        tabIndex={0}
                        disabled={
                          isSyncBusy ||
                          !canSyncDisplayedRepo ||
                          suggestedAction.disabled
                        }
                        onClick={() => handleAction(suggestedAction.onSelect)}
                        icon={
                          <SuggestedActionIcon
                            size={MENU_ICON_SIZE}
                            className="shrink-0 text-text-1"
                          />
                        }
                      >
                        <span className="font-medium">
                          {suggestedAction.label}
                        </span>
                      </DropdownItem>
                    )}
                    <div className={DROPDOWN_CLASSES.menuSeparator} />
                    <DropdownItem
                      role="menuitem"
                      fullWidth
                      tabIndex={0}
                      onClick={() => setShowAllActions(true)}
                      icon={
                        <Ellipsis
                          size={MENU_ICON_SIZE}
                          className="text-text-1"
                        />
                      }
                    >
                      <span className="font-medium">{t("common.more")}</span>
                    </DropdownItem>
                  </>
                )}
              </div>
            </div>,
            document.body
          )}
      </div>
    );
  }
);

GitSyncStatusMenu.displayName = "GitSyncStatusMenu";

export default GitSyncStatusMenu;
