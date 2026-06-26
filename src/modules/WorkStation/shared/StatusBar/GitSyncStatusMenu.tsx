import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CloudUpload,
  Ellipsis,
  RefreshCw,
} from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { classNames } from "@src/util/ui/classNames";

import { StatusBarButton } from "./StatusBarBase";

const MENU_ICON_SIZE = DROPDOWN_ITEM.iconSize;

interface GitSyncStatusMenuProps {
  branchName: string;
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
  disabled?: boolean;
  onSelect: () => Promise<void> | void;
}

export const GitSyncStatusMenu: React.FC<GitSyncStatusMenuProps> = memo(
  ({
    branchName,
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
          onSelect: onFetch,
        },
        {
          key: "sync",
          label: "Pull then push",
          disabled: needsPublish,
          onSelect: onSync,
        },
        {
          key: "pull",
          label: "Pull",
          disabled: needsPublish,
          onSelect: onPull,
        },
        {
          key: "rebase",
          label: "Pull with rebase",
          disabled: needsPublish,
          onSelect: onRebase,
        },
        {
          key: "push",
          label: needsPublish ? "Publish" : "Push",
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

    const title = needsPublish
      ? t("workstation.publishBranchToOrigin", { branch: branchName })
      : behindCount > 0 || aheadCount > 0
        ? t("workstation.syncWithRemote", {
            behind: behindCount,
            ahead: aheadCount,
          })
        : t("workstation.refreshGitStatus");

    return (
      <div ref={triggerRef} className="flex h-full">
        <StatusBarButton
          onClick={handleToggle}
          disabled={isSyncBusy || !canSyncDisplayedRepo}
          title={title}
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
              <span className="font-medium text-text-1">{syncStatusLabel}</span>
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
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {showAllActions ? "Git actions" : "Suggested Git action"}
                </div>
                {showAllActions ? (
                  <>
                    {actions.map((action) => {
                      const disabled =
                        isSyncBusy || !canSyncDisplayedRepo || action.disabled;
                      return (
                        <button
                          key={action.key}
                          type="button"
                          className={classNames(
                            DROPDOWN_CLASSES.menuActionItem,
                            disabled && DROPDOWN_CLASSES.itemDisabled
                          )}
                          disabled={disabled}
                          onClick={() => handleAction(action.onSelect)}
                          role="menuitem"
                        >
                          <span className="font-medium text-text-1">
                            {action.label}
                          </span>
                        </button>
                      );
                    })}
                  </>
                ) : (
                  <>
                    {suggestedAction && (
                      <button
                        type="button"
                        className={classNames(
                          DROPDOWN_CLASSES.menuActionItem,
                          (isSyncBusy ||
                            !canSyncDisplayedRepo ||
                            suggestedAction.disabled) &&
                            DROPDOWN_CLASSES.itemDisabled
                        )}
                        disabled={
                          isSyncBusy ||
                          !canSyncDisplayedRepo ||
                          suggestedAction.disabled
                        }
                        onClick={() => handleAction(suggestedAction.onSelect)}
                        role="menuitem"
                      >
                        <span className="font-medium text-text-1">
                          {suggestedAction.label}
                        </span>
                      </button>
                    )}
                    <div className={DROPDOWN_CLASSES.menuSeparator} />
                    <button
                      type="button"
                      className={DROPDOWN_CLASSES.menuActionItem}
                      onClick={() => setShowAllActions(true)}
                      role="menuitem"
                    >
                      <Ellipsis size={MENU_ICON_SIZE} className="text-text-1" />
                      <span className="font-medium text-text-1">
                        More options
                      </span>
                    </button>
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
