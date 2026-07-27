import {
  Braces,
  Clipboard,
  FolderOutput,
  Link2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Search,
  Share2,
} from "lucide-react";
import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { DropdownItem } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Switch from "@src/components/Switch";
import type { DropdownEnginePosition } from "@src/hooks/dropdown";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";

const HEADER_ICON_SIZE = 14;

export interface SessionHeaderActionsMenuProps {
  activeSessionExists: boolean;
  copyEventJsonLabel: "idle" | "copied" | "failed";
  currentSessionId: string | null;
  displayMode: ChatHistoryDisplayMode;
  eventsLength: number;
  handleCompactDisplayModeToggle: (checked: boolean) => void;
  handleCopyEventJson: () => void;
  handleMoveSession: () => void;
  handleOpenCloudShareSettings: () => void;
  handleOpenExportSessionJson: () => void;
  handleOpenLinkWorkItem: () => void;
  handleOpenRawTranscript: () => void;
  handleOpenSearch: () => void;
  handlePaginationToggle: (checked: boolean) => void;
  handleReloadFromMenu: () => void;
  handleTokenUsageVisibleToggle: (checked: boolean) => void;
  headerActionsDropdownRef: React.RefObject<HTMLDivElement | null>;
  headerActionsPosition: DropdownEnginePosition;
  headerActionsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  isHeaderActionsOpen: boolean;
  isHeaderActionsPositioned: boolean;
  moveTarget: "chat-panel" | "workstation";
  paginationEnabled: boolean;
  showCloudShareSettings: boolean;
  showTranscriptActions?: boolean;
  tokenUsageVisible: boolean;
  toggleHeaderActionsMenu: () => void;
  triggerTestId: string;
}

/** The canonical session dropdown shared by Chat Panel and My Station. */
export const SessionHeaderActionsMenu: React.FC<
  SessionHeaderActionsMenuProps
> = ({
  activeSessionExists,
  copyEventJsonLabel,
  currentSessionId,
  displayMode,
  eventsLength,
  handleCompactDisplayModeToggle,
  handleCopyEventJson,
  handleMoveSession,
  handleOpenCloudShareSettings,
  handleOpenExportSessionJson,
  handleOpenLinkWorkItem,
  handleOpenRawTranscript,
  handleOpenSearch,
  handlePaginationToggle,
  handleReloadFromMenu,
  handleTokenUsageVisibleToggle,
  headerActionsDropdownRef,
  headerActionsPosition,
  headerActionsTriggerRef,
  isHeaderActionsOpen,
  isHeaderActionsPositioned,
  moveTarget,
  paginationEnabled,
  showCloudShareSettings,
  showTranscriptActions = true,
  tokenUsageVisible,
  toggleHeaderActionsMenu,
  triggerTestId,
}) => {
  const { t } = useTranslation(["sessions", "common", "navigation"]);
  const moveToWorkstation = moveTarget === "workstation";

  return (
    <>
      <Button
        ref={headerActionsTriggerRef}
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        className={isHeaderActionsOpen ? "!bg-fill-1 !text-primary-6" : ""}
        onClick={(event) => {
          event.stopPropagation();
          toggleHeaderActionsMenu();
        }}
        aria-label={t("common:actions.more")}
        aria-expanded={isHeaderActionsOpen}
        data-testid={triggerTestId}
        icon={<MoreHorizontal size={HEADER_ICON_SIZE} strokeWidth={2} />}
      />
      {isHeaderActionsOpen &&
        isHeaderActionsPositioned &&
        createPortal(
          <div
            ref={headerActionsDropdownRef}
            className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
            style={{
              position: "fixed",
              top: headerActionsPosition.top ?? 0,
              right: headerActionsPosition.right ?? 0,
              zIndex: 9999,
            }}
          >
            {showTranscriptActions && (
              <DropdownItem
                role="menuitem"
                fullWidth
                tabIndex={0}
                onClick={handleOpenSearch}
                icon={
                  <Search size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                }
              >
                {t("chat.findInChat")}
              </DropdownItem>
            )}
            <DropdownItem
              role="menuitem"
              fullWidth
              tabIndex={0}
              onClick={handleReloadFromMenu}
              disabled={!currentSessionId}
              icon={
                <RefreshCw size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              }
            >
              {t("common:actions.reload")}
            </DropdownItem>
            <DropdownItem
              role="menuitem"
              fullWidth
              tabIndex={0}
              onClick={handleMoveSession}
              disabled={!currentSessionId}
              dataTestId={
                moveToWorkstation
                  ? "move-session-to-workstation"
                  : "move-session-to-chat-panel"
              }
              icon={
                moveToWorkstation ? (
                  <PanelLeft size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                ) : (
                  <PanelRight
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                )
              }
            >
              {moveToWorkstation
                ? t("chat.moveToWorkstation", {
                    defaultValue: "Move to My Workstation",
                  })
                : t("chat.moveToChatPanel", {
                    defaultValue: "Move to Chat Panel",
                  })}
            </DropdownItem>
            {showTranscriptActions && (
              <>
                <DropdownItem
                  role="menuitem"
                  fullWidth
                  tabIndex={0}
                  onClick={handleCopyEventJson}
                  disabled={eventsLength === 0}
                  icon={
                    <Clipboard
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={1.75}
                    />
                  }
                >
                  {copyEventJsonLabel === "copied"
                    ? t("chat.copyEventJsonCopied")
                    : copyEventJsonLabel === "failed"
                      ? t("chat.copyEventJsonFailed")
                      : t("chat.copyEventJson")}
                </DropdownItem>
                <DropdownItem
                  role="menuitem"
                  fullWidth
                  tabIndex={0}
                  onClick={handleOpenRawTranscript}
                  disabled={!currentSessionId}
                  dataTestId="view-raw-session-transcript"
                  icon={
                    <Braces size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                  }
                >
                  {t("chat.rawTranscript.menuItem", {
                    defaultValue: "View raw transcript",
                  })}
                </DropdownItem>
              </>
            )}
            <DropdownItem
              role="menuitem"
              fullWidth
              tabIndex={0}
              onClick={handleOpenLinkWorkItem}
              disabled={!currentSessionId}
              dataTestId="session-link-work-item-button"
              icon={<Link2 size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />}
            >
              {t("chat.linkWorkItem.menuItem")}
            </DropdownItem>
            {showCloudShareSettings && (
              <DropdownItem
                role="menuitem"
                fullWidth
                tabIndex={0}
                onClick={handleOpenCloudShareSettings}
                dataTestId="cloud-session-share-settings-button"
                icon={
                  <Share2 size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                }
              >
                {t("navigation:cloud.share.menuItem")}
              </DropdownItem>
            )}
            {showTranscriptActions && (
              <>
                <DropdownItem
                  role="menuitem"
                  fullWidth
                  tabIndex={0}
                  onClick={handleOpenExportSessionJson}
                  disabled={!activeSessionExists}
                  icon={
                    <FolderOutput
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={1.75}
                    />
                  }
                >
                  {t("chat.importExport.exportAction")}
                </DropdownItem>
                <div className="my-1 border-t border-solid border-border-2" />
                <div
                  className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
                >
                  <span className="flex-1 truncate">
                    {t("chat.showTokenUsage")}
                  </span>
                  <Switch
                    checked={tokenUsageVisible}
                    onChange={handleTokenUsageVisibleToggle}
                    size="small"
                    ariaLabel={t("chat.showTokenUsage")}
                  />
                </div>
                <div
                  className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
                >
                  <span className="flex-1 truncate">
                    {t("common:pagination.title")}
                  </span>
                  <Switch
                    checked={paginationEnabled}
                    onChange={handlePaginationToggle}
                    size="small"
                    ariaLabel={t("common:pagination.title")}
                  />
                </div>
                <div
                  className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
                >
                  <span className="flex-1 truncate">
                    {t("chat.compactDisplayMode")}
                  </span>
                  <Switch
                    checked={displayMode === "compact"}
                    onChange={handleCompactDisplayModeToggle}
                    size="small"
                    ariaLabel={t("chat.compactDisplayMode")}
                  />
                </div>
              </>
            )}
          </div>,
          document.body
        )}
    </>
  );
};

SessionHeaderActionsMenu.displayName = "SessionHeaderActionsMenu";
