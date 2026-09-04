import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { trackSessionAsProject } from "@src/api/tauri/agent/session";
import Button from "@src/components/Button";
import {
  ActionMenuSurface,
  ActionSubmenu,
} from "@src/components/Dropdown/ActionMenuSurface";
import DropdownItem from "@src/components/Dropdown/DropdownItem";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Message from "@src/components/Message";
import Switch from "@src/components/Switch";
import { useCopySessionReference } from "@src/features/Org2Cloud/useCopySessionReference";
import type { DropdownEnginePosition } from "@src/hooks/dropdown";
import {
  AppWindowMacIcon,
  Copy01Icon,
  CursorInWindowIcon,
  DeliveryBox01Icon,
  FolderOutputIcon,
  HugeiconsIcon,
  Layers01Icon,
  Link01Icon,
  Link02Icon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PanelRightIcon,
  Refresh04Icon,
  Search01Icon,
  Share02Icon,
  ThirdBracketIcon,
} from "@src/icons";
import { sessionByIdAtom, upsertSession } from "@src/store/session";
import { pinnedActionsVisibleAtom } from "@src/store/session/pinnedActionsVisibleAtom";
import { openSessionInNewWindowAtom } from "@src/store/session/sessionTabPlacementAtom";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";
import { isAgentSession } from "@src/util/session/sessionDispatch";

import { SessionOpenInAppMenuItem } from "./SessionOpenInAppMenuItem";

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
  /** Off in the detached session window, whose only surface is the session. */
  showMoveSession?: boolean;
  /** Off in the detached session window — it already is that window. */
  showOpenInNewWindow?: boolean;
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
  showMoveSession = true,
  showOpenInNewWindow = true,
  showTranscriptActions = true,
  tokenUsageVisible,
  turnMetadataVisible,
  toggleHeaderActionsMenu,
  triggerTestId,
}) => {
  const { t } = useTranslation(["sessions", "common", "navigation"]);
  const moveToWorkstation = moveTarget === "workstation";

  const currentSession = useAtomValue(sessionByIdAtom(currentSessionId ?? ""));
  const [pinnedActionsVisible, setPinnedActionsVisible] = useAtom(
    pinnedActionsVisibleAtom
  );
  const showSkillsLabel = t("chat.startPage.showSkills");

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

  // Open in new window — detach the session into its own OS window and drop
  // this window's tab(s) for it. Self-contained like Track-as-Project: the
  // atom talks to the backend and both tab owners, so neither host has to
  // wire a handler through.
  const openSessionInNewWindow = useSetAtom(openSessionInNewWindowAtom);
  const handleOpenInNewWindow = React.useCallback(async () => {
    if (!currentSessionId) return;
    toggleHeaderActionsMenu();
    try {
      await openSessionInNewWindow({
        sessionId: currentSessionId,
        title: currentSession?.name,
      });
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    }
  }, [
    currentSessionId,
    currentSession,
    openSessionInNewWindow,
    toggleHeaderActionsMenu,
  ]);

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
        className={isHeaderActionsOpen ? "bg-fill-1! text-primary-6!" : ""}
        onClick={(event) => {
          event.stopPropagation();
          toggleHeaderActionsMenu();
        }}
        aria-label={t("common:actions.more")}
        aria-expanded={isHeaderActionsOpen}
        data-testid={triggerTestId}
        icon={
          <HugeiconsIcon
            icon={MoreHorizontalIcon}
            data-icon="ellipsis"
            size={HEADER_ICON_SIZE}
            strokeWidth={2}
          />
        }
      />
      {isHeaderActionsOpen &&
        isHeaderActionsPositioned &&
        createPortal(
          <ActionMenuSurface
            panelRef={headerActionsDropdownRef}
            onClose={toggleHeaderActionsMenu}
            className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
            style={{
              position: "fixed",
              top: headerActionsPosition.top ?? 0,
              right: headerActionsPosition.right ?? 0,
              zIndex: DROPDOWN_PANEL.zIndex,
            }}
          >
            {showTranscriptActions && (
              <DropdownItem
                role="menuitem"
                fullWidth
                tabIndex={0}
                onClick={handleOpenSearch}
                icon={
                  <HugeiconsIcon
                    icon={Search01Icon}
                    data-icon="search"
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
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
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                />
              }
            >
              {t("common:actions.reload")}
            </DropdownItem>
            {(showMoveSession || showOpenInNewWindow) && (
              <ActionSubmenu
                label={t("chat.moveTo")}
                icon={
                  <HugeiconsIcon
                    icon={CursorInWindowIcon}
                    data-icon="cursor-in-window"
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                }
                disabled={!currentSessionId}
                dataTestId="session-move-submenu"
              >
                {showMoveSession && (
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
                        <HugeiconsIcon
                          icon={PanelLeftIcon}
                          data-icon="panel-left"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={1.75}
                        />
                      ) : (
                        <HugeiconsIcon
                          icon={PanelRightIcon}
                          data-icon="panel-right"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={1.75}
                        />
                      )
                    }
                  >
                    {moveToWorkstation
                      ? t("chat.moveToWorkstation", {
                          defaultValue: "Move to My Station",
                        })
                      : t("chat.moveToChatPanel", {
                          defaultValue: "Move to Chat Panel",
                        })}
                  </DropdownItem>
                )}
                {showOpenInNewWindow && (
                  <DropdownItem
                    role="menuitem"
                    fullWidth
                    tabIndex={0}
                    onClick={handleOpenInNewWindow}
                    disabled={!currentSessionId}
                    dataTestId="open-session-in-new-window"
                    icon={
                      <HugeiconsIcon
                        icon={AppWindowMacIcon}
                        data-icon="app-window-mac"
                        size={DROPDOWN_ITEM.iconSize}
                        strokeWidth={1.75}
                      />
                    }
                  >
                    {t("common:actions.openInNewWindow")}
                  </DropdownItem>
                )}
              </ActionSubmenu>
            )}
            {(showTranscriptActions || canCopyReference) && (
              <ActionSubmenu
                label={t("chat.copyAndExport")}
                icon={
                  <HugeiconsIcon
                    icon={Copy01Icon}
                    data-icon="copy"
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                }
                dataTestId="session-copy-submenu"
              >
                {showTranscriptActions && (
                  <DropdownItem
                    role="menuitem"
                    fullWidth
                    tabIndex={0}
                    onClick={handleCopyEventJson}
                    disabled={eventsLength === 0}
                    dataTestId="session-copy-event-json-button"
                    icon={
                      <HugeiconsIcon
                        icon={ThirdBracketIcon}
                        data-icon="braces"
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
                )}
                {canCopyReference && (
                  <DropdownItem
                    role="menuitem"
                    fullWidth
                    tabIndex={0}
                    onClick={handleCopySessionUrl}
                    dataTestId="session-copy-url-button"
                    icon={
                      <HugeiconsIcon
                        icon={Link01Icon}
                        data-icon="link"
                        size={DROPDOWN_ITEM.iconSize}
                        strokeWidth={1.75}
                      />
                    }
                  >
                    {copyReferenceLabel}
                  </DropdownItem>
                )}
                {showTranscriptActions && (
                  <DropdownItem
                    role="menuitem"
                    fullWidth
                    tabIndex={0}
                    onClick={handleOpenExportSessionJson}
                    disabled={!activeSessionExists}
                    dataTestId="session-export-button"
                    icon={
                      <HugeiconsIcon
                        icon={FolderOutputIcon}
                        data-icon="folder-output"
                        size={DROPDOWN_ITEM.iconSize}
                        strokeWidth={1.75}
                      />
                    }
                  >
                    {t("chat.importExport.exportJson")}
                  </DropdownItem>
                )}
              </ActionSubmenu>
            )}
            {showCloudShareSettings && (
              <DropdownItem
                role="menuitem"
                fullWidth
                tabIndex={0}
                onClick={handleOpenCloudShareSettings}
                dataTestId="cloud-session-share-settings-button"
                icon={
                  <HugeiconsIcon
                    icon={Share02Icon}
                    data-icon="share-2"
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                }
              >
                {t("navigation:cloud.share.menuItem")}
              </DropdownItem>
            )}
            <ActionSubmenu
              label={t("chat.projectLinks")}
              icon={
                <HugeiconsIcon
                  icon={Link02Icon}
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                />
              }
              disabled={!currentSessionId}
              dataTestId="session-project-links-submenu"
            >
              <DropdownItem
                role="menuitem"
                fullWidth
                tabIndex={0}
                onClick={handleTrackAsProject}
                disabled={!canTrackAsProject}
                dataTestId="session-track-as-project-button"
                icon={
                  <HugeiconsIcon
                    icon={DeliveryBox01Icon}
                    data-icon="box"
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                }
              >
                {t("sessions:chat.trackAsProject.menuItem")}
              </DropdownItem>
              <DropdownItem
                role="menuitem"
                fullWidth
                tabIndex={0}
                onClick={handleOpenLinkWorkItem}
                disabled={!currentSessionId}
                dataTestId="session-link-work-item-button"
                icon={
                  <HugeiconsIcon
                    icon={Link02Icon}
                    data-icon="link-2"
                    size={DROPDOWN_ITEM.iconSize}
                    strokeWidth={1.75}
                  />
                }
              >
                {t("chat.linkWorkItem.menuItem")}
              </DropdownItem>
            </ActionSubmenu>
            <SessionOpenInAppMenuItem
              key={currentSessionId}
              sessionId={currentSessionId}
              onCloseMenu={toggleHeaderActionsMenu}
            />
            {showTranscriptActions && (
              <>
                <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                <ActionSubmenu
                  label={t("common:actions.uiSettings")}
                  icon={
                    <HugeiconsIcon
                      icon={Layers01Icon}
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={1.75}
                    />
                  }
                  dataTestId="session-ui-settings-submenu"
                >
                  <div
                    className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
                  >
                    <span className="flex-1 truncate">{showSkillsLabel}</span>
                    <Switch
                      checked={pinnedActionsVisible}
                      onCheckedChange={setPinnedActionsVisible}
                      size="small"
                      ariaLabel={showSkillsLabel}
                      dataTestId="session-menu-show-skills-toggle"
                    />
                  </div>
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
                </ActionSubmenu>
              </>
            )}
          </ActionMenuSurface>,
          document.body
        )}
    </>
  );
};

SessionHeaderActionsMenu.displayName = "SessionHeaderActionsMenu";
