import { MessageSquareText, MonitorPlay } from "lucide-react";
import React, {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";

import { Placeholder } from "@src/components/Placeholder";
import TabPill from "@src/components/TabPill";
import type { SessionTranscriptRuntime } from "@src/engines/ChatPanel/SessionTranscriptRuntimeContext";
import { RemoteSessionChatPanelSurface } from "@src/engines/ChatPanel/components/RemoteSessionChatPanelSurface";
import { SessionRawToolbarActions } from "@src/engines/ChatPanel/components/SessionViewSwitcher";
import type { SessionViewMode } from "@src/engines/ChatPanel/hooks/useSessionViewMode";
import { useViewportWidth } from "@src/engines/ChatPanel/hooks/useViewportWidth";
import type { SessionEvent, SessionLoadStatus } from "@src/engines/SessionCore";
import { resolveReplayEventWindow } from "@src/engines/SessionCore/replay/projectReplayEventWindow";
import type { ReplayControllerState } from "@src/engines/SessionCore/replay/replayController";
import { resolveReplayEventIndex } from "@src/engines/SessionCore/replay/resolveReplayEventLookup";
import { useReplayController } from "@src/engines/SessionCore/replay/useReplayController";
import { RemoteSessionReplayControls } from "@src/engines/Simulator/components/RemoteSessionReplayControls";
import { RemoteSessionWorkstationSurface } from "@src/engines/Simulator/components/RemoteSessionWorkstationSurface";

import { WebSessionAlternateSurface } from "./WebSessionAlternateSurface";
import WebSessionCommentsHeaderExtras from "./WebSessionCommentsHeaderExtras";
import { WebSessionHeaderViewControls } from "./WebSessionHeaderViewControls";
import { useWebSessions } from "./WebSessionsContext";
import { useCloudSessionEvents } from "./useCloudSessionEvents";
import type { WebSessionListItem } from "./useWebSessionRoster";
import { useWebSessionViewMode } from "./useWebSessionViewMode";
import { matchesWebSessionPath } from "./webSessionLocation";

type MobilePane = "workstation" | "chat";

const SPLIT_VIEW_MIN_WIDTH = 1024;

interface WebSessionTranscriptPaneProps {
  session: WebSessionListItem;
  sessionKey: string;
  events: readonly SessionEvent[];
  runtime: SessionTranscriptRuntime;
  headerContent: React.ReactNode;
  headerExtras: React.ReactNode;
  sessionViewMode: SessionViewMode;
  alternateSessionView: React.ReactNode;
}

const WebSessionTranscriptPane = memo(function WebSessionTranscriptPane({
  session,
  sessionKey,
  events,
  runtime,
  headerContent,
  headerExtras,
  sessionViewMode,
  alternateSessionView,
}: WebSessionTranscriptPaneProps) {
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-chat-pane"
      aria-label="Session chat transcript"
      data-session-pane="chat"
    >
      <RemoteSessionChatPanelSurface
        key={sessionKey}
        sessionId={session.sourceSessionId}
        agentDisplayName={session.agentDisplayName || session.cliAgentType}
        remoteSession={session}
        events={events as SessionEvent[]}
        runtime={runtime}
        headerContent={headerContent}
        headerExtras={headerExtras}
        sessionViewMode={sessionViewMode}
        alternateSessionView={alternateSessionView}
      />
    </section>
  );
});

interface WebSessionWorkstationPaneProps {
  session: WebSessionListItem;
  sessionKey: string;
  events: readonly SessionEvent[];
  replayEndIndex: number;
  currentEventId: string | null;
  loadStatus: SessionLoadStatus;
  loadError: string | null;
  loadProgress: {
    loadedEvents: number;
    totalEvents: number | null;
  } | null;
  replayState: ReplayControllerState;
  onRetry: () => void;
  onSeek: (index: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onBrowse: () => void;
  onFollow: () => void;
  onSpeedChange: (speed: ReplayControllerState["speed"]) => void;
}

const WebSessionWorkstationPane = memo(function WebSessionWorkstationPane({
  session,
  sessionKey,
  events,
  replayEndIndex,
  currentEventId,
  loadStatus,
  loadError,
  loadProgress,
  replayState,
  onRetry,
  onSeek,
  onPlay,
  onPause,
  onBrowse,
  onFollow,
  onSpeedChange,
}: WebSessionWorkstationPaneProps) {
  const deferredReplayEndIndex = useDeferredValue(replayEndIndex);

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-workstation-bg"
      aria-label="Session WorkStation replay"
      data-session-pane="workstation"
    >
      <RemoteSessionWorkstationSurface
        key={sessionKey}
        sessionId={session.sourceSessionId}
        events={events as SessionEvent[]}
        loadStatus={loadStatus}
        loadError={loadError}
        loadProgress={loadProgress}
        onRetry={onRetry}
        currentEventId={currentEventId}
        replayEndIndex={deferredReplayEndIndex}
      />
      <div
        className="pointer-events-none absolute inset-0 z-30"
        data-session-replay-host="workstation"
      >
        <RemoteSessionReplayControls
          state={replayState}
          onSeek={onSeek}
          onPlay={onPlay}
          onPause={onPause}
          onBrowse={onBrowse}
          onFollow={onFollow}
          onSpeedChange={onSpeedChange}
        />
      </div>
    </section>
  );
});

export function WebSessionPage({
  replayInitially = false,
}: {
  replayInitially?: boolean;
}) {
  const { t } = useTranslation("navigation");
  const params = useParams<{ orgId: string; sessionId: string }>();
  const viewportWidth = useViewportWidth();
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const {
    sessions,
    status: rosterStatus,
    sessionFetchStateByOrg,
    refresh: refreshRoster,
  } = useWebSessions();
  const session =
    sessions.find((candidate) =>
      matchesWebSessionPath(candidate, params.orgId, params.sessionId)
    ) ?? null;
  const targetSessionFetchState = params.orgId
    ? sessionFetchStateByOrg[params.orgId]
    : undefined;
  const cloudEvents = useCloudSessionEvents(session);
  const {
    events,
    status: transcriptStatus,
    error: transcriptError,
    progress: transcriptProgress,
    refresh: refreshTranscript,
  } = cloudEvents;
  const sessionView = useWebSessionViewMode({
    sessionId: session?.sourceSessionId ?? null,
    events,
    switchable: session?.eventsEpoch !== undefined,
  });
  const replay = useReplayController(events.length);
  const { seek, state: replayState } = replay;
  const initializedReplaySessionRef = useRef<string | null>(null);
  const sessionKey = session ? `${session.orgId}:${session.id}` : null;
  const transcriptPublished = session?.eventsEpoch !== undefined;
  const fallbackName = session?.title?.trim() || t("web.sessionPage.chatTab");

  useEffect(() => {
    if (!replayInitially || !sessionKey || events.length === 0) return;
    if (initializedReplaySessionRef.current === sessionKey) return;
    initializedReplaySessionRef.current = sessionKey;
    seek(0);
  }, [events.length, replayInitially, seek, sessionKey]);

  const replayWindow = useMemo(
    () =>
      resolveReplayEventWindow(
        events.length,
        replayState.phase,
        replayState.index
      ),
    [events.length, replayState.index, replayState.phase]
  );
  const currentEventId = useMemo(() => {
    if (events.length === 0) return null;
    if (replayWindow.isFullWindow) {
      return events[events.length - 1]?.id ?? null;
    }
    return events[replayWindow.endIndex]?.id ?? null;
  }, [events, replayWindow]);
  const reloadTranscript = useCallback(
    () => void refreshTranscript(),
    [refreshTranscript]
  );
  const navigateToEvent = useCallback(
    (eventId: string) => {
      const index = resolveReplayEventIndex(events, eventId);
      if (index < 0) return;
      replay.seek(index);
      setMobilePane("workstation");
    },
    [events, replay]
  );
  const runtime = useMemo(
    () => ({
      loadStatus: transcriptStatus,
      loadError: transcriptError,
      isAgentWorking: session?.status === "running",
      onReload: reloadTranscript,
      onNavigateToEvent: navigateToEvent,
      capabilities: {
        canvasInline: false,
        turnMetadata: transcriptPublished,
      },
    }),
    [
      navigateToEvent,
      reloadTranscript,
      session?.status,
      transcriptError,
      transcriptPublished,
      transcriptStatus,
    ]
  );

  const headerContent = useMemo(
    () =>
      session ? (
        <WebSessionHeaderViewControls
          session={session}
          fallbackName={fallbackName}
          rosterSessions={sessions}
          view={sessionView}
          testIdPrefix="web-session"
        />
      ) : null,
    [fallbackName, session, sessionView, sessions]
  );

  const headerExtras = useMemo(
    () =>
      session ? (
        <>
          <WebSessionCommentsHeaderExtras session={session} />
          <SessionRawToolbarActions
            view={sessionView}
            testIdPrefix="web-session"
          />
        </>
      ) : null,
    [session, sessionView]
  );

  const alternateSessionView = useMemo(
    () =>
      session && sessionView.mode !== "gui" ? (
        <WebSessionAlternateSurface session={session} view={sessionView} />
      ) : null,
    [session, sessionView]
  );

  if (!session) {
    const targetFailed =
      rosterStatus === "error" || targetSessionFetchState === "error";
    const targetPending =
      !targetFailed &&
      (rosterStatus === "loading" ||
        targetSessionFetchState === "idle" ||
        targetSessionFetchState === "loading");
    return (
      <main className="flex h-full items-center justify-center bg-workstation-bg p-6">
        <Placeholder
          variant={targetFailed ? "error" : targetPending ? "loading" : "empty"}
          placement="detail-panel"
          title={
            targetPending
              ? undefined
              : targetFailed
                ? t("web.sessionsPage.loadError")
                : t("web.sessionPage.notFound")
          }
          subtitle={
            targetPending
              ? t("web.sessionPage.loading")
              : targetFailed
                ? t("web.sessionsPage.sessionRefreshErrorHint")
                : t("web.sessionPage.notFoundHint")
          }
          onRetry={targetFailed ? () => void refreshRoster() : undefined}
        />
      </main>
    );
  }

  const showSplitView =
    viewportWidth === undefined || viewportWidth >= SPLIT_VIEW_MIN_WIDTH;

  const transcript = (
    <WebSessionTranscriptPane
      session={session}
      sessionKey={sessionKey!}
      events={events}
      runtime={runtime}
      headerContent={headerContent}
      headerExtras={headerExtras}
      sessionViewMode={sessionView.mode}
      alternateSessionView={alternateSessionView}
    />
  );

  const workstation = (
    <WebSessionWorkstationPane
      session={session}
      sessionKey={sessionKey!}
      events={events}
      replayEndIndex={replayWindow.endIndex}
      currentEventId={currentEventId}
      loadStatus={transcriptStatus}
      loadError={transcriptError}
      loadProgress={transcriptProgress}
      replayState={replayState}
      onRetry={reloadTranscript}
      onSeek={replay.seek}
      onPlay={replay.play}
      onPause={replay.pause}
      onBrowse={replay.browse}
      onFollow={replay.follow}
      onSpeedChange={replay.setSpeed}
    />
  );

  return (
    <main className="flex h-full min-h-0 flex-col bg-workstation-bg">
      {!showSplitView && (
        <div className="shrink-0 border-b border-border-2 bg-pane-raised p-2">
          <TabPill
            tabs={[
              {
                key: "chat",
                label: t("web.sessionPage.chatTab"),
                icon: <MessageSquareText size={14} aria-hidden />,
              },
              {
                key: "workstation",
                label: t("web.sessionPage.workstationTab"),
                icon: <MonitorPlay size={14} aria-hidden />,
              },
            ]}
            activeTab={mobilePane}
            onChange={(key) => setMobilePane(key as MobilePane)}
            variant="pill"
            size="small"
          />
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1">
        {showSplitView ? (
          <>
            <div className="flex w-2/5 min-w-96 max-w-xl shrink-0 border-r border-border-2">
              {transcript}
            </div>
            {workstation}
          </>
        ) : mobilePane === "chat" ? (
          transcript
        ) : (
          workstation
        )}
      </div>
    </main>
  );
}
