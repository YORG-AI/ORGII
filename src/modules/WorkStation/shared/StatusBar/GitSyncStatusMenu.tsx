import React, { memo, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowDownToLineIcon,
  ArrowUp02Icon,
  ArrowUpFromLineIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  EllipsisIcon,
  GitCompareIcon,
  HugeiconsIcon,
  type IconSvgElement,
  Refresh04Icon,
} from "@src/icons";
import { classNames } from "@src/util/ui/classNames";

import { StatusBarButton, StatusBarLabel } from "./StatusBarBase";
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
  icon: IconSvgElement;
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
          icon: CloudDownloadIcon,
          onSelect: onFetch,
        },
        {
          key: "sync",
          label: "Pull then push",
          icon: Refresh04Icon,
          disabled: needsPublish,
          onSelect: onSync,
        },
        {
          key: "pull",
          label: "Pull",
          icon: ArrowDownToLineIcon,
          disabled: needsPublish,
          onSelect: onPull,
        },
        {
          key: "rebase",
          label: "Pull with rebase",
          icon: GitCompareIcon,
          disabled: needsPublish,
          onSelect: onRebase,
        },
        {
          key: "push",
          label: needsPublish ? "Publish" : "Push",
          icon: needsPublish ? CloudUploadIcon : ArrowUpFromLineIcon,
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
              <HugeiconsIcon
                icon={CloudUploadIcon}
                data-icon="cloud-upload"
                size={MENU_ICON_SIZE}
                className="text-text-1"
              />
            ) : (
              <HugeiconsIcon
                icon={Refresh04Icon}
                data-icon="refresh-cw"
                size={MENU_ICON_SIZE}
                className={`text-text-1 ${syncSpinClass ?? ""}`}
              />
            )}
            {needsPublish && !isPublishing && (
              <StatusBarLabel emphasis className="text-text-1">
                {t("git.actions.publish")}
              </StatusBarLabel>
            )}
            {isPublishing && (
              <StatusBarLabel emphasis className="text-text-1">
                {t("workstation.publishingBranch")}
              </StatusBarLabel>
            )}
            {!needsPublish &&
              syncStatusLabel &&
              behindCount === 0 &&
              aheadCount === 0 && (
                <StatusBarLabel emphasis className="text-text-1">
                  {syncStatusLabel}
                </StatusBarLabel>
              )}
            {!needsPublish && (behindCount > 0 || aheadCount > 0) && (
              <>
                <StatusBarLabel
                  emphasis
                  numeric
                  className="flex items-center text-text-1"
                >
                  {behindCount}
                  <HugeiconsIcon
                    icon={ArrowDown02Icon}
                    data-icon="arrow-down"
                    size={MENU_ICON_SIZE}
                  />
                </StatusBarLabel>
                <StatusBarLabel
                  emphasis
                  numeric
                  className="flex items-center text-text-1"
                >
                  {aheadCount}
                  <HugeiconsIcon
                    icon={ArrowUp02Icon}
                    data-icon="arrow-up"
                    size={MENU_ICON_SIZE}
                  />
                </StatusBarLabel>
              </>
            )}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              data-icon="chevron-down"
              size={12}
              className="text-text-3"
            />
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
                          <AnyIcon
                            icon={action.icon}
                            size={MENU_ICON_SIZE}
                            className="shrink-0 text-text-1"
                          />
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
                        <AnyIcon
                          icon={suggestedAction.icon}
                          size={MENU_ICON_SIZE}
                          className="shrink-0 text-text-1"
                        />
                        <span className="font-medium text-text-1">
                          {suggestedAction.label}
                        </span>
                      </button>
                    )}
                    <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                    <button
                      type="button"
                      className={DROPDOWN_CLASSES.menuActionItem}
                      onClick={() => setShowAllActions(true)}
                      role="menuitem"
                    >
                      <HugeiconsIcon
                        icon={EllipsisIcon}
                        data-icon="ellipsis"
                        size={MENU_ICON_SIZE}
                        className="text-text-1"
                      />
                      <span className="font-medium text-text-1">
                        {t("common.more")}
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
