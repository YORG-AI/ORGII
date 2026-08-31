/**
 * SessionWindowPage — the standalone route a detached session window loads.
 *
 * Rendered by `appStandaloneRouteGroup` (outside `AppShell`), so the window
 * carries no sidebar, workstation, or chat-panel chrome: one session surface,
 * composed exactly like the Workstation `chat-session` tab renderer
 * (`WorkStation/TabContent/renderers/chatSession.tsx`) but with the header
 * inline instead of published to a tab host, and with `ChatView` as the
 * window's PRIMARY surface — this webview has its own Jotai store, so the
 * global event pipeline here belongs to this session alone.
 *
 * The provider stack mirrors the slice of `AppLayout` a session surface
 * needs (`DataProvider → ChatProvider → SessionSyncProvider` + the
 * EventStore/queue bridges from `GlobalSessionSync`). The full
 * `GlobalSessionSync` is deliberately not mounted — native notification
 * delivery is main-window-owned and would double-fire — but the native
 * session-status monitor DOES run here with notifications off, so renames,
 * account switches and cross-session status reach this window's store.
 *
 * Session-row hydration is owned by the content surfaces themselves —
 * `ChatView` and `HumanSessionView` both call `loadSessions({forceRefresh})`
 * when the row is missing — so a cold window converges without extra wiring.
 */
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import { DataProvider } from "@src/contexts/workspace/DataContext";
import { useReloadSession } from "@src/engines/ChatPanel/ChatHistory/hooks/useReloadSession";
import SessionContentView from "@src/engines/ChatPanel/SessionContentView";
import { SessionHeaderActionsMenu } from "@src/engines/ChatPanel/components/SessionHeaderActionsMenu";
import {
  SessionAlternateSurface,
  SessionHeaderViewControls,
  SessionRawToolbarActions,
} from "@src/engines/ChatPanel/components/SessionViewSwitcher";
import {
  CHAT_PANEL_HEADER_DRAG_STYLE,
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
} from "@src/engines/ChatPanel/header";
import { shouldStartHeaderDragFromTarget } from "@src/engines/ChatPanel/header/chatPanelHeaderLayout";
import { useSessionActionModals } from "@src/engines/ChatPanel/hooks/useSessionActionModals";
import { useSessionHeaderActions } from "@src/engines/ChatPanel/hooks/useSessionHeaderActions";
import { useSessionViewMode } from "@src/engines/ChatPanel/hooks/useSessionViewMode";
import { useEventStoreBridge } from "@src/engines/SessionCore/core/store/useEventStoreBridge";
import GlobalPlanningIndicatorBridgeSync from "@src/engines/SessionCore/hooks/replay/GlobalPlanningIndicatorBridgeSync";
import { useQueueDispatch } from "@src/engines/SessionCore/hooks/session/useQueueDispatch";
import SessionSyncProvider from "@src/engines/SessionCore/sync/SessionSyncProvider";
import SessionViewersIndicator from "@src/features/Org2Cloud/SessionViewersIndicator";
import { useNativeSessionStatusMonitor } from "@src/hooks/session/useNativeSessionStatusMonitor";
import { getChatPanelBackgroundStyle } from "@src/modules/shared/layouts/viewContainerTokens";
import { sessionByIdAtom } from "@src/store/session";
import type { SessionContinuation } from "@src/store/session/sessionTabPlacementAtom";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import { isMacOS, isWindows } from "@src/util/platform/tauri";
import { isHumanSession } from "@src/util/session/sessionDispatch";

/** Path the detached window navigates to for one session. Must stay in sync
 *  with the Rust route in `app_window::commands::open_session_window` and the
 *  `appStandaloneRouteGroup` entry. */
export function getSessionWindowPath(sessionId: string): string {
  return `/orgii/app/session/${encodeURIComponent(sessionId)}`;
}

/** Width reserved for the macOS overlay traffic lights (x=20 + 3 buttons),
 *  mirroring MACOS_TRAFFIC_LIGHTS_RESERVED_WIDTH in
 *  useCollapsedSidebarChromeOffset. */
const MACOS_TRAFFIC_LIGHTS_INSET_PX = 84;

/** The EventStore→Jotai and queue bridges this window needs from
 *  `GlobalSessionSync`, plus the native session-status monitor with
 *  notifications off: renames, account switches and status changes keep
 *  this window's store (header title, ModelPill, sleep inhibitor) live,
 *  while native notification delivery stays main-window-owned. */
const SessionWindowBridges: React.FC = () => {
  useEventStoreBridge();
  useQueueDispatch();
  useNativeSessionStatusMonitor({ notifications: false });
  return <GlobalPlanningIndicatorBridgeSync />;
};

const SessionWindowContent: React.FC<{ sessionId: string }> = memo(
  ({ sessionId }) => {
    const { t } = useTranslation([
      "sessions",
      "common",
      "projects",
      "navigation",
    ]);
    const navigate = useNavigate();
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
    const headerActions = useSessionHeaderActions({
      sessionId: sessionId || null,
      handleReloadSession,
    });
    const { closeHeaderActionsMenu } = headerActions;
    const sessionActions = useSessionActionModals({
      activeSession: session,
      closeHeaderActionsMenu,
      currentSession: session ?? null,
      currentSessionId: sessionId || null,
      t,
    });

    // A continuation retargets this window in place — same behavior as the
    // in-app session pills, expressed as route navigation because the route
    // param is this window's tab state.
    const handleSessionContinuation = useCallback(
      (continuation: SessionContinuation) => {
        navigate(getSessionWindowPath(continuation.sessionId), {
          replace: true,
        });
      },
      [navigate]
    );

    // Keep the native window title on the session name (it was seeded by the
    // open command, but renames and continuations happen after that).
    const sessionName = session?.name?.trim() || "";
    useEffect(() => {
      if (!sessionName) return;
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().setTitle(sessionName)
        )
        .catch(() => undefined);
    }, [sessionName]);

    const windowsHost = isWindows();

    // The `data-tauri-drag-region` attribute only reacts to mousedowns whose
    // TARGET carries the attribute — child elements swallow most of the row.
    // Mirror ChatPanelHeader's collapsed-header fallback: any left-press on a
    // non-interactive part of the header starts a native drag, and a
    // double-press toggles maximize. Windows keeps its native title bar.
    const handleHeaderMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
      if (windowsHost || event.button !== 0) return;
      if (!shouldStartHeaderDragFromTarget(event.target as Element | null)) {
        return;
      }
      const maximize = event.detail === 2;
      event.preventDefault();
      void import("@src/util/platform/ipcRenderer").then(
        ({ maxWindow, startWindowDrag }) =>
          maximize ? maxWindow() : startWindowDrag()
      );
    };

    if (!sessionId) return null;
    return (
      <div
        data-chat-panel
        className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-chat-pane text-sm"
        style={chatPanelSurfaceStyle}
      >
        {/* Same one-row chrome the tab hosts give a session surface. On
            macOS the row doubles as the drag strip behind the overlay
            traffic lights; on Windows the native title bar owns dragging. */}
        <div
          className="relative z-40 flex h-11 min-h-11 flex-shrink-0 items-center gap-1.5 pr-[7px] pt-2"
          data-testid="session-window-header"
          data-tauri-drag-region={windowsHost ? undefined : true}
          onMouseDown={handleHeaderMouseDown}
          style={{
            paddingLeft: isMacOS() ? MACOS_TRAFFIC_LIGHTS_INSET_PX : 12,
            ...(windowsHost
              ? CHAT_PANEL_HEADER_NO_DRAG_STYLE
              : CHAT_PANEL_HEADER_DRAG_STYLE),
          }}
        >
          <div
            className="flex min-w-0 flex-1 items-center"
            style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
          >
            <SessionHeaderViewControls
              session={session}
              sessionId={sessionId}
              fallbackName={sessionName || "Chat"}
              onParentSessionClick={handleSessionContinuation}
              view={sessionView}
              testIdPrefix="session-window"
            />
          </div>
          <div
            className="flex shrink-0 items-center gap-px"
            style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
          >
            <SessionViewersIndicator sessionId={sessionId || null} />
            <SessionRawToolbarActions
              view={sessionView}
              testIdPrefix="session-window"
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
              handleMoveSession={() => undefined}
              handleOpenCloudShareSettings={
                sessionActions.handleOpenCloudShareSettings
              }
              handleOpenExportSessionJson={
                sessionActions.handleOpenExportSessionJson
              }
              handleOpenLinkWorkItem={sessionActions.handleOpenLinkWorkItem}
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
              isHeaderActionsPositioned={
                headerActions.isHeaderActionsPositioned
              }
              moveTarget="chat-panel"
              paginationEnabled={headerActions.paginationEnabled}
              showCloudShareSettings={sessionActions.showCloudShareSettings}
              showMoveSession={false}
              showOpenInNewWindow={false}
              showTranscriptActions={!humanSession}
              tokenUsageVisible={headerActions.tokenUsageVisible}
              turnMetadataVisible={headerActions.turnMetadataVisible}
              toggleHeaderActionsMenu={headerActions.toggleHeaderActionsMenu}
              triggerTestId="session-window-header-more-button"
            />
          </div>
        </div>
        {/* Hidden, never unmounted — see ChatPanelContent for why the
            virtualized transcript must survive a view switch. */}
        <div
          className={`min-h-0 flex-1 flex-col overflow-hidden ${
            sessionViewMode === "gui" ? "flex" : "hidden"
          }`}
        >
          <SessionContentView
            sessionId={sessionId}
            displayMode={headerActions.displayMode}
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

SessionWindowContent.displayName = "SessionWindowContent";

const SessionWindowPage: React.FC = () => {
  const { sessionId = "" } = useParams<{ sessionId: string }>();

  return (
    <div className="h-full min-h-0 w-full">
      <DataProvider>
        <ChatProvider>
          <SessionSyncProvider>
            <SessionWindowBridges />
            <SessionWindowContent sessionId={sessionId} />
          </SessionSyncProvider>
        </ChatProvider>
      </DataProvider>
    </div>
  );
};

export default SessionWindowPage;
