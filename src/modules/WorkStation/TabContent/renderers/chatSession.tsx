/**
 * Renderer wrapper for `chat-session` tabs.
 *
 * `ChatView` is self-contained (reads from session atoms by id). The
 * editor host wraps it in a chat-gradient container and claims the session as
 * a secondary live surface. This keeps streaming and continuation interactive
 * without rewriting the session workspace to the Workstation's current repo.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { Clipboard, RefreshCw } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import TabPill from "@src/components/TabPill";
import { useReloadSession } from "@src/engines/ChatPanel/ChatHistory/hooks/useReloadSession";
import SessionContentView from "@src/engines/ChatPanel/SessionContentView";
import { SessionHeaderActionsMenu } from "@src/engines/ChatPanel/components/SessionHeaderActionsMenu";
import SessionHeaderBreadcrumb from "@src/engines/ChatPanel/components/SessionHeaderBreadcrumb";
import { useSessionRawTranscript } from "@src/engines/ChatPanel/components/SessionRawTranscriptDialog/useSessionRawTranscript";
import SessionRawTranscriptView from "@src/engines/ChatPanel/components/SessionRawTranscriptView";
import { useSessionActionModals } from "@src/engines/ChatPanel/hooks/useSessionActionModals";
import { useSessionHeaderActions } from "@src/engines/ChatPanel/hooks/useSessionHeaderActions";
import SessionViewersIndicator from "@src/features/Org2Cloud/SessionViewersIndicator";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import { sessionByIdAtom } from "@src/store/session";
import type { SessionContinuation } from "@src/store/session/sessionTabPlacementAtom";
import {
  moveSessionTabAtom,
  retargetWorkstationSessionTabAtom,
} from "@src/store/session/sessionTabPlacementAtom";
import { isHumanSession } from "@src/util/session/sessionDispatch";

import type { UnifiedTabContentProps } from "../types";

type SessionViewMode = "gui" | "raw";

interface SessionViewState {
  mode: SessionViewMode;
  sessionId: string;
}

const ChatSessionTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation([
      "sessions",
      "common",
      "projects",
      "navigation",
    ]);
    const sessionId = String(tab.data.sessionId ?? "");
    const [sessionViewState, setSessionViewState] = useState<SessionViewState>({
      mode: "gui",
      sessionId,
    });
    const session = useAtomValue(sessionByIdAtom(sessionId));
    const humanSession =
      session?.category === "human_session" || isHumanSession(sessionId);
    const sessionViewMode = humanSession
      ? "gui"
      : sessionViewState.sessionId === sessionId
        ? sessionViewState.mode
        : "gui";
    const transcript = useSessionRawTranscript(
      sessionId || null,
      sessionViewMode === "raw"
    );
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
    const sessionViewTabs = useMemo(
      () => [
        {
          key: "gui",
          label: t("chat.rawTranscript.guiTab", { defaultValue: "GUI" }),
        },
        {
          key: "raw",
          label: t("chat.rawTranscript.rawTab", { defaultValue: "Raw" }),
        },
      ],
      [t]
    );
    const handleSessionViewChange = useCallback(
      (key: string) => {
        if (key !== "gui" && key !== "raw") return;
        setSessionViewState({ mode: key, sessionId });
      },
      [sessionId]
    );
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
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <SessionHeaderBreadcrumb
            session={session}
            sessionId={sessionId}
            fallbackName={sessionName}
            onParentSessionClick={handleSessionContinuation}
          />
          {!humanSession && (
            <>
              <span
                className="pointer-events-none mx-1.5 h-4 w-px shrink-0 bg-border-2"
                aria-hidden
              />
              <TabPill
                activeTab={sessionViewMode}
                tabs={sessionViewTabs}
                onChange={handleSessionViewChange}
                variant="pill"
                color="fill"
                fillWidth={false}
                size="small"
              />
            </>
          )}
        </div>
      ),
      [
        handleSessionViewChange,
        handleSessionContinuation,
        session,
        sessionId,
        sessionName,
        sessionViewMode,
        sessionViewTabs,
        humanSession,
      ]
    );
    const refreshLabel = t("common:actions.refresh", "Refresh");
    const copyLabel = t("common:actions.copy", "Copy");
    const headerTrailing = (
      <div className="flex shrink-0 items-center gap-px">
        <SessionViewersIndicator sessionId={sessionId || null} />
        {sessionViewMode === "raw" ? (
          <>
            <Button
              size="small"
              variant="tertiary"
              icon={<RefreshCw size={14} strokeWidth={2} />}
              iconOnly
              loading={transcript.loading}
              aria-label={refreshLabel}
              title={refreshLabel}
              data-testid="workstation-session-raw-refresh-button"
              onClick={() => void transcript.loadTranscript()}
            />
            <Button
              size="small"
              variant="tertiary"
              icon={<Clipboard size={14} strokeWidth={2} />}
              iconOnly
              disabled={!transcript.snapshot || transcript.loading}
              aria-label={copyLabel}
              title={copyLabel}
              data-testid="workstation-session-raw-copy-button"
              onClick={() => void transcript.copyTranscript()}
            />
          </>
        ) : null}
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
          handleOpenRawTranscript={sessionActions.handleOpenRawTranscript}
          handleOpenSearch={headerActions.handleOpenSearch}
          handlePaginationToggle={headerActions.handlePaginationToggle}
          handleReloadFromMenu={headerActions.handleReloadFromMenu}
          handleTokenUsageVisibleToggle={
            headerActions.handleTokenUsageVisibleToggle
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
        className="flex h-full min-w-0 flex-1 flex-col overflow-hidden text-sm"
        style={{
          background:
            "linear-gradient(180deg, var(--color-bg-1) 0%, var(--color-fill-1) 100%)",
        }}
      >
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
        {!humanSession && sessionViewMode === "raw" ? (
          <SessionRawTranscriptView
            sessionId={sessionId}
            transcript={transcript}
          />
        ) : null}
        {sessionActions.sessionModals}
      </div>
    );
  }
);

ChatSessionTabRenderer.displayName = "ChatSessionTabRenderer";

export default ChatSessionTabRenderer;
