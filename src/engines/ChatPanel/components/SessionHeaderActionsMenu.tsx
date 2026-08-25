import { useAtomValue } from "jotai";
import {
  BellOff,
  Braces,
  Clipboard,
  FolderKanban,
  FolderOutput,
  Link,
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

import { trackSessionAsProject } from "@src/api/tauri/agent/session";
import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Message from "@src/components/Message";
import Switch from "@src/components/Switch";
import { useCopySessionReference } from "@src/features/Org2Cloud/useCopySessionReference";
import type { DropdownEnginePosition } from "@src/hooks/dropdown";
import { useSessionNotificationMute } from "@src/hooks/notifications/useSessionNotificationMute";
import { sessionByIdAtom, upsertSession } from "@src/store/session";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";
import { isAgentSession } from "@src/util/session/sessionDispatch";

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
  handleTurnMetadataVisibleToggle: (checked: boolean) => void;
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
  turnMetadataVisible: boolean;
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
  handleTurnMetadataVisibleToggle,
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
  turnMetadataVisible,
  toggleHeaderActionsMenu,
  triggerTestId,
}) => {
  const { t } = useTranslation(["sessions", "common", "navigation"]);
  const moveToWorkstation = moveTarget === "workstation";
  const { isMuted: sessionNotificationsMuted, setMuted } =
    useSessionNotificationMute(currentSessionId);

  const currentSession = useAtomValue(sessionByIdAtom(currentSessionId ?? ""));

  // Track this / Convert to Project (orgtrack/v1 §7.2). Self-contained:
  // the backend command persists the switch + root WorkItem; only the
  // local store row needs a merge afterwards.
  const canTrackAsProject =
    !!currentSessionId &&
    isAgentSession(currentSessionId) &&
    currentSession?.productMode !== "project";
  const handleTrackAsProject = React.useCallback(async () => {
    if (!currentSessionId) return;
    toggleHeaderActionsMenu();
    try {
      const result = await trackSessionAsProject(currentSessionId);
      if (currentSession) {
        upsertSession({
          ...currentSession,
          productMode: result.productMode,
          agentExecMode: result.agentExecMode,
          workItemId: result.workItemId ?? currentSession.workItemId,
        });
      }
      Message.success(t("sessions:chat.trackAsProject.success"));
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    }
  }, [currentSessionId, toggleHeaderActionsMenu, currentSession, t]);

  // Copy URL — the non-secret `orgii://cloud/session/ref` reference, same
  // action as the sidebar row menus. Hidden until the session has been
  // published to a cloud org, because a reference to an unpublished session
  // resolves for nobody (see useCopySessionReference).
  const { isCopyReferenceEligible, handleCopyReference, copyReferenceLabel } =
    useCopySessionReference();
  const canCopyReference =
    !!currentSession && isCopyReferenceEligible(currentSession);
  const handleCopySessionUrl = React.useCallback(() => {
    if (!currentSession) return;
    toggleHeaderActionsMenu();
    handleCopyReference(currentSession);
  }, [currentSession, handleCopyReference, toggleHeaderActionsMenu]);

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
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
                onClick={handleOpenSearch}
              >
                <Search size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                <span className="flex-1 truncate">{t("chat.findInChat")}</span>
              </button>
            )}
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleReloadFromMenu}
              disabled={!currentSessionId}
            >
              <RefreshCw size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">
                {t("common:actions.reload")}
              </span>
            </button>
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleMoveSession}
              disabled={!currentSessionId}
              data-testid={
                moveToWorkstation
                  ? "move-session-to-workstation"
                  : "move-session-to-chat-panel"
              }
            >
              {moveToWorkstation ? (
                <PanelLeft size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              ) : (
                <PanelRight size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              )}
              <span className="flex-1 truncate">
                {moveToWorkstation
                  ? t("chat.moveToWorkstation", {
                      defaultValue: "Move to My Station",
                    })
                  : t("chat.moveToChatPanel", {
                      defaultValue: "Move to Chat Panel",
                    })}
              </span>
            </button>
            {showTranscriptActions && (
              <>
                <button
                  type="button"
                  className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
                  onClick={handleCopyEventJson}
                  disabled={eventsLength === 0}
                >
                  <Clipboard size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                  <span className="flex-1 truncate">
                    {copyEventJsonLabel === "copied"
                      ? t("chat.copyEventJsonCopied")
                      : copyEventJsonLabel === "failed"
                        ? t("chat.copyEventJsonFailed")
                        : t("chat.copyEventJson")}
                  </span>
                </button>
                <button
                  type="button"
                  className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
                  onClick={handleOpenRawTranscript}
                  disabled={!currentSessionId}
                  data-testid="view-raw-session-transcript"
                >
                  <Braces size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                  <span className="flex-1 truncate">
                    {t("chat.rawTranscript.menuItem", {
                      defaultValue: "View raw transcript",
                    })}
                  </span>
                </button>
              </>
            )}
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleTrackAsProject}
              disabled={!canTrackAsProject}
              data-testid="session-track-as-project-button"
            >
              <FolderKanban size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">
                {t("sessions:chat.trackAsProject.menuItem")}
              </span>
            </button>
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleOpenLinkWorkItem}
              disabled={!currentSessionId}
              data-testid="session-link-work-item-button"
            >
              <Link2 size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">
                {t("chat.linkWorkItem.menuItem")}
              </span>
            </button>
            <div
              className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
              data-testid="session-notification-mute-row"
            >
              <BellOff size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">
                {t("chat.muteNotifications", {
                  defaultValue: "Mute notifications",
                })}
              </span>
              <Switch
                checked={sessionNotificationsMuted}
                disabled={!currentSessionId}
                onCheckedChange={setMuted}
                size="small"
                ariaLabel={t("chat.muteNotifications", {
                  defaultValue: "Mute notifications",
                })}
              />
            </div>
            {showCloudShareSettings && (
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
                onClick={handleOpenCloudShareSettings}
                data-testid="cloud-session-share-settings-button"
              >
                <Share2 size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                <span className="flex-1 truncate">
                  {t("navigation:cloud.share.menuItem")}
                </span>
              </button>
            )}
            {canCopyReference && (
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
                onClick={handleCopySessionUrl}
                data-testid="session-copy-url-button"
              >
                <Link size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                <span className="flex-1 truncate">{copyReferenceLabel}</span>
              </button>
            )}
            {showTranscriptActions && (
              <>
                <button
                  type="button"
                  className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
                  onClick={handleOpenExportSessionJson}
                  disabled={!activeSessionExists}
                >
                  <FolderOutput
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                  <span className="flex-1 truncate">
                    {t("chat.importExport.exportAction")}
                  </span>
                </button>
                <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
                <div
                  className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
                >
                  <span className="flex-1 truncate">
                    {t("chat.showTokenUsage")}
                  </span>
                  <Switch
                    checked={tokenUsageVisible}
                    onCheckedChange={handleTokenUsageVisibleToggle}
                    size="small"
                    ariaLabel={t("chat.showTokenUsage")}
                  />
                </div>
                <div
                  className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
                >
                  <span className="flex-1 truncate">
                    {t("chat.showTurnMetadata")}
                  </span>
                  <Switch
                    checked={turnMetadataVisible}
                    onCheckedChange={handleTurnMetadataVisibleToggle}
                    size="small"
                    ariaLabel={t("chat.showTurnMetadata")}
                    dataTestId="session-menu-turn-metadata-toggle"
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
                    onCheckedChange={handlePaginationToggle}
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
                    onCheckedChange={handleCompactDisplayModeToggle}
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
