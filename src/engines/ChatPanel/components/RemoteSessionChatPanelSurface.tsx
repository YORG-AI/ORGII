import React, { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import SelectorPill from "@src/components/SelectorPill";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import type { SessionEvent } from "@src/engines/SessionCore";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

import { ChatPanelShell } from "../ChatPanelShell";
import SessionReadOnlyBar from "../InputArea/components/SessionReadOnlyBar";
import type { SessionTranscriptRuntime } from "../SessionTranscriptRuntimeContext";
import { ChatPanelPublishedHeader } from "../header";
import type { SessionViewMode } from "../hooks/useSessionViewMode";
import { SessionTranscriptSurface } from "./SessionTranscriptSurface";

type RemoteSessionIdentity = Pick<
  RemoteTeammateSessionMetadata,
  | "sourceSessionId"
  | "cliAgentType"
  | "agentDisplayName"
  | "agentDefinitionId"
  | "model"
  | "origin"
>;

export interface RemoteSessionChatPanelSurfaceProps {
  sessionId: string;
  agentDisplayName?: string | null;
  remoteSession?: RemoteSessionIdentity | null;
  events: SessionEvent[];
  runtime: SessionTranscriptRuntime;
  /** Replaces the default agent-only header leading content when provided. */
  headerContent?: React.ReactNode;
  /** Extra trailing header nodes rendered before the read-only label. */
  headerExtras?: React.ReactNode;
  sessionViewMode?: SessionViewMode;
  alternateSessionView?: React.ReactNode;
}

/**
 * Desktop ChatPanel presentation backed by caller-owned remote events.
 * It intentionally has no send or replay controls: the transcript is live,
 * while the shared composer chrome communicates Cloud read-only mode. Replay
 * remains owned by the sibling WorkStation surface.
 */
export function RemoteSessionChatPanelSurface({
  sessionId,
  agentDisplayName,
  remoteSession,
  events,
  runtime,
  headerContent,
  headerExtras,
  sessionViewMode = "gui",
  alternateSessionView,
}: RemoteSessionChatPanelSurfaceProps) {
  const { t } = useTranslation("navigation");
  const { t: tSessions } = useTranslation("sessions");
  const panelRef = useRef<HTMLDivElement>(null);
  const display = useMemo(
    () =>
      remoteSession
        ? resolveSessionDisplayMetadata({
            kind: "remote",
            session: remoteSession,
          })
        : null,
    [remoteSession]
  );
  const agentLabel =
    agentDisplayName ||
    display?.agentLabel ||
    tSessions("chat.agentFallback", "Agent");
  const sessionIconElement = useMemo(
    () =>
      React.createElement(resolveAgentIcon(display?.agentIconId), {
        size: 14,
        className: "shrink-0 text-text-3",
        "aria-hidden": true,
      }),
    [display?.agentIconId]
  );
  const readOnlyHeaderTrailing = t("web.readOnly.headerTrailing");
  const readOnlyBarLabel = t("web.readOnly.barLabel");
  const readOnlyBarPlaceholder = t("web.readOnly.barPlaceholder");

  const publishedHeaderSlots = useMemo(
    () => ({
      content: headerContent ?? (
        <div className="flex min-w-0 items-center gap-2">
          {sessionIconElement}
          <span className="truncate text-sm font-medium text-text-1">
            {agentLabel}
          </span>
        </div>
      ),
      trailing: (
        <div className="flex shrink-0 items-center gap-px">
          {headerExtras}
          <span className="pr-1 text-xs text-text-3">
            {readOnlyHeaderTrailing}
          </span>
        </div>
      ),
    }),
    [
      sessionIconElement,
      agentLabel,
      headerContent,
      headerExtras,
      readOnlyHeaderTrailing,
    ]
  );

  const headerSection = (
    <ChatPanelPublishedHeader
      slots={publishedHeaderSlots}
      windowsHost={false}
    />
  );

  const alternateActive = sessionViewMode !== "gui";

  const chatColumn = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className={`min-h-0 flex-1 flex-col ${
          alternateActive ? "hidden" : "flex"
        }`}
      >
        <SessionTranscriptSurface
          sessionId={sessionId}
          events={events}
          runtime={runtime}
        />
      </div>
      {alternateActive ? alternateSessionView : null}
      <div className="shrink-0 bg-chat-pane">
        <div
          className={`px-2 pt-1 ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}`}
          data-remote-read-only-composer
        >
          <div
            className={`mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
          >
            <SessionReadOnlyBar
              label={readOnlyBarLabel}
              placeholder={readOnlyBarPlaceholder}
              showContextInfo={false}
              pills={
                <SelectorPill
                  label={agentLabel}
                  disabled
                  ariaLabel={readOnlyBarPlaceholder}
                />
              }
            />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-remote-session-chat-panel
    >
      <ChatPanelShell
        activeTab={null}
        borderClasses=""
        chatColumn={chatColumn}
        chatPanelOpacityStyle={{}}
        chatWidth={0}
        chatWidthStyleValue="100%"
        embedded
        headerSection={headerSection}
        isDragging={false}
        isLeftPosition={false}
        isTerminalTabActive={false}
        onResizeMouseDown={() => undefined}
        panelRef={panelRef}
        sessionModals={null}
        showResizeHandle={false}
        terminalTabs={[]}
        useExternalWidth
      />
    </div>
  );
}
