/**
 * Renderer wrapper for `chat-session` tabs.
 *
 * `ChatView` is self-contained (reads from session atoms by id). The
 * editor host wraps it in a chat-gradient container and claims the session as
 * a secondary live surface. This keeps streaming and continuation interactive
 * without rewriting the session workspace to the Workstation's current repo.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useReloadSession } from "@src/engines/ChatPanel/ChatHistory/hooks/useReloadSession";
import SessionContentView from "@src/engines/ChatPanel/SessionContentView";
import { SessionHeaderActionsMenu } from "@src/engines/ChatPanel/components/SessionHeaderActionsMenu";
import {
  SessionAlternateSurface,
  SessionHeaderViewControls,
  SessionRawToolbarActions,
} from "@src/engines/ChatPanel/components/SessionViewSwitcher";
import { useSessionActionModals } from "@src/engines/ChatPanel/hooks/useSessionActionModals";
import { useSessionHeaderActions } from "@src/engines/ChatPanel/hooks/useSessionHeaderActions";
import { useSessionViewMode } from "@src/engines/ChatPanel/hooks/useSessionViewMode";
import SessionViewersIndicator from "@src/features/Org2Cloud/SessionViewersIndicator";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { getChatPanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import { sessionByIdAtom } from "@src/store/session";
import type { SessionContinuation } from "@src/store/session/sessionTabPlacementAtom";
import {
  moveSessionTabAtom,
  retargetWorkstationSessionTabAtom,
} from "@src/store/session/sessionTabPlacementAtom";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import { isHumanSession } from "@src/util/session/sessionDispatch";

import type { UnifiedTabContentProps } from "../types";

const ChatSessionTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation([
      "sessions",
      "common",
      "projects",
      "navigation",
    ]);
    const sessionId = String(tab.data.sessionId ?? "");
    const session = useAtomValue(sessionByIdAtom(sessionId));
    const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
    const chatPanelSurfaceStyle = useMemo(
      () => getChatPanelBackgroundStyle(backgroundConfig.pageOpacity),
      [backgroundConfig.pageOpacity]
    );
    const humanSession =
      session?.category === "human_session" || isHumanSession(sessionId);
    const sessionView = useSessionViewMode({
      sessionId: sessionId || null,
      humanSession,
    });
    const sessionViewMode = sessionView.mode;
    const handleReloadSession = useReloadSession(sessionId || null);
    const retargetSessionTab = useSetAtom(retargetWorkstationSessionTabAtom);
    const moveSessionTab = useSetAtom(moveSessionTabAtom);
    const headerActions = useSessionHeaderActions({ handleReloadSession });
    const { closeHeaderActionsMenu } = headerActions;
    const sessionActions = useSessionActionModals({
      activeSession: session,
      closeHeaderActionsMenu,
      currentSession: session ?? null,
      currentSessionId: sessionId || null,
      t,
    });
    const handleSessionContinuation = useCallback(
      (continuation: SessionContinuation) => {
        retargetSessionTab({
          ...continuation,
          sourceSessionId: sessionId,
          tabId: tab.id,
        });
      },
      [retargetSessionTab, sessionId, tab.id]
    );

    const sessionName = session?.name?.trim() || tab.title || "Chat";
    const handleMoveToChatPanel = useCallback(() => {
      if (!sessionId) return;
      moveSessionTab({
        source: "workstation",
        sourceTabId: tab.id,
        sessionId,
        title: sessionName,
      });
      closeHeaderActionsMenu();
    }, [
      closeHeaderActionsMenu,
      moveSessionTab,
      sessionId,
      sessionName,
      tab.id,
    ]);
    const headerContent = useMemo(
      () => (
        <SessionHeaderViewControls
          session={session}
          sessionId={sessionId}
          fallbackName={sessionName}
          onParentSessionClick={handleSessionContinuation}
          view={sessionView}
          testIdPrefix="workstation-session"
        />
      ),
      [handleSessionContinuation, session, sessionId, sessionName, sessionView]
    );
    const headerTrailing = (
      <div className="flex shrink-0 items-center gap-px">
        <SessionViewersIndicator sessionId={sessionId || null} />
        <SessionRawToolbarActions
          view={sessionView}
          testIdPrefix="workstation-session"
        />
        <SessionHeaderActionsMenu
          activeSessionExists={Boolean(session)}
          copyEventJsonLabel={headerActions.copyEventJsonLabel}
          currentSessionId={sessionId || null}
          displayMode={headerActions.displayMode}
          eventsLength={headerActions.eventCount}
          handleCompactDisplayModeToggle={
            headerActions.handleCompactDisplayModeToggle
          }
          handleCopyEventJson={headerActions.handleCopyEventJson}
          handleMoveSession={handleMoveToChatPanel}
          handleOpenCloudShareSettings={
            sessionActions.handleOpenCloudShareSettings
          }
          handleOpenExportSessionJson={
            sessionActions.handleOpenExportSessionJson
          }
          handleOpenLinkWorkItem={sessionActions.handleOpenLinkWorkItem}
          handleOpenRawTranscript={sessionView.showRaw}
          handleOpenSearch={headerActions.handleOpenSearch}
          handlePaginationToggle={headerActions.handlePaginationToggle}
          handleReloadFromMenu={headerActions.handleReloadFromMenu}
          handleTokenUsageVisibleToggle={
            headerActions.handleTokenUsageVisibleToggle
          }
          handleTurnMetadataVisibleToggle={
            headerActions.handleTurnMetadataVisibleToggle
          }
          headerActionsDropdownRef={headerActions.headerActionsDropdownRef}
          headerActionsPosition={headerActions.headerActionsPosition}
          headerActionsTriggerRef={headerActions.headerActionsTriggerRef}
          isHeaderActionsOpen={headerActions.isHeaderActionsOpen}
          isHeaderActionsPositioned={headerActions.isHeaderActionsPositioned}
          moveTarget="chat-panel"
          paginationEnabled={headerActions.paginationEnabled}
          showCloudShareSettings={sessionActions.showCloudShareSettings}
          showTranscriptActions={!humanSession}
          tokenUsageVisible={headerActions.tokenUsageVisible}
          turnMetadataVisible={headerActions.turnMetadataVisible}
          toggleHeaderActionsMenu={headerActions.toggleHeaderActionsMenu}
          triggerTestId="workstation-session-header-more-button"
        />
      </div>
    );

    usePublishWorkstationTabHeader({
      host: "code",
      content: {
        content: headerContent,
        trailing: headerTrailing,
        sidebarToggleDisabled: true,
      },
    });

    if (!sessionId) return null;
    return (
      <div
        data-chat-panel
        className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-chat-pane text-sm"
        style={chatPanelSurfaceStyle}
      >
        {/* Hidden, never unmounted — see ChatPanelContent for why the
            virtualized transcript must survive a view switch. */}
        <div
          className={`min-h-0 flex-1 flex-col overflow-hidden ${
            sessionViewMode === "gui" ? "flex" : "hidden"
          }`}
        >
          <SessionContentView
            sessionId={sessionId}
            secondary
            displayMode={headerActions.displayMode}
            onRegisterSearchOpen={headerActions.handleRegisterSearchOpen}
            onSessionContinuation={handleSessionContinuation}
            turnPaginationEnabled={headerActions.paginationEnabled}
          />
        </div>
        <SessionAlternateSurface sessionId={sessionId} view={sessionView} />
        {sessionActions.sessionModals}
      </div>
    );
  }
);

ChatSessionTabRenderer.displayName = "ChatSessionTabRenderer";

export default ChatSessionTabRenderer;
