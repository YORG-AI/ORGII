/**
 * ChatPanelSideChat
 *
 * Global floating picture-in-picture chat window. Hosted by `AppLayout`
 * over the whole pane surface (chat slot + workbench), so it works whether
 * the chat pane is open or a station fills the view. The window shell
 * reuses the kanban session-preview machinery — `FloatingWindow` (drag
 * bounds + resize handles) with a draggable `DetailPanelHeader`.
 *
 * # Why NOT `SessionContentView` / `ChatView`
 *
 * The full `ChatView` claims the single global event pipeline
 * (`activeSessionIdAtom` → `derivedSnapshotAtom`), which can only hold ONE
 * session's events. The kanban preview gets away with a `secondary` claim
 * because the primary chat column is hidden while the board tab is active;
 * the side chat instead floats NEXT TO a visible main chat, so claiming
 * the pipeline would hijack the main transcript. We therefore render the
 * side session the way subagent grid cells do (`SubagentChatPane`):
 * `ChatSessionContext.Provider` + `ChatProvider` route `ChatHistory` to
 * `chatEventsForSessionAtomFamily(sessionId)` — a per-session snapshot
 * subscription that streams live without touching the global pipeline.
 * Sending goes through `SessionService.sendMessage`, which is adapter-
 * routed per session id, via the composer's `onSubmitOverride` (the
 * `ChannelComposer` call shape).
 *
 * Two body modes, driven by `sideChatSessionIdAtom`:
 *   - session id → that session's live chat + composer;
 *   - `null`     → the session creator (new-session mode); a successful
 *                  background launch adopts the new session in place.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import DetailPanelHeader from "@src/components/DetailPanelHeader";
import FloatingWindow from "@src/components/FloatingWindow";
import { SESSION_CONFIG } from "@src/config/sessionCreatorConfig";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { createLogger } from "@src/hooks/logger";
import {
  BubbleChatIcon,
  HugeiconsIcon,
  LinkSquare02Icon,
  PencilEdit02Icon,
} from "@src/icons";
import {
  activeChatPanelTabTypeAtom,
  openOrFocusSessionInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionMapAtom } from "@src/store/session";
import {
  chatTurnPaginationEnabledAtom,
  chatVisibleAtom,
  restoreChatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  closeSideChatAtom,
  openSideChatAtom,
  sideChatSessionIdAtom,
  sideChatVisibleAtom,
} from "@src/store/ui/sideChatAtom";
import { isSessionInProgress } from "@src/util/session/sessionInProgress";
import { stripPillReferences } from "@src/util/session/stripPillReferences";

import ChatHistory from "../ChatHistory";
import { ChatSessionContext } from "../ChatSessionContext";
import InputArea from "../InputArea";
import type { SubmitOverrideInput } from "../hooks/useInputArea/types";
import type { ChatPanelProps } from "../types";
import { shouldShowSideChatLauncher } from "./sideChatLauncherVisibility";

const log = createLogger("ChatPanelSideChat");

// The overlay is the drag/resize bounds: the whole pane surface (chat slot
// z-10 + workbench z-0) minus a 12px inset, so the window can never touch or
// cross an edge. z-[70] floats above both and above the kanban tab's own
// overlays (z-[60]).
const SIDE_CHAT_OVERLAY_CLASS =
  "pointer-events-none absolute inset-0 z-[70] flex items-end justify-end p-3";
const SIDE_CHAT_LAUNCHER_CLASS =
  "pointer-events-none absolute bottom-4 right-4 z-[70]";

// Initial fluid geometry: bottom-right corner, px-capped (kanban preview
// pattern: fill small panes, stop growing past the cap on large ones). The
// first manual resize pins the surface to explicit px geometry.
//
// `@container/focusedchat` re-scopes the chat pane's container queries to
// this window: responsive chrome inside (e.g. the launchpad hero's
// "What do you want to build?" lines, which need a 640px container) sizes
// against the floating surface instead of the whole pane — so the hero
// shows just the agent-name pill here.
const SIDE_CHAT_SURFACE_CLASS =
  "pointer-events-auto flex h-full max-h-[600px] min-h-[360px] w-[420px] max-w-full flex-col overflow-hidden rounded-[12px] border border-border-2 bg-bg-2 shadow-2xl @container/focusedchat";

// Manual-resize limits (the pane bounds still apply on top of the maxes).
const SIDE_CHAT_MIN_WIDTH = 320;
const SIDE_CHAT_MIN_HEIGHT = 360;
const SIDE_CHAT_MAX_WIDTH = 640;
const SIDE_CHAT_MAX_HEIGHT = 720;

export interface ChatPanelSideChatProps {
  /**
   * Same injected creator the chat pane start page renders — passed through
   * so new-session mode shares the pane's launch surface (and its ADE
   * awareness) instead of ChatPanel depending on SessionCreator directly.
   */
  SessionCreatorSlot?: ChatPanelProps["sessionCreatorSlot"];
}

interface SideChatLauncherProps {
  label: string;
  onOpen: () => void;
}

export function SideChatLauncher({
  label,
  onOpen,
}: SideChatLauncherProps): React.ReactNode {
  return (
    <div className={SIDE_CHAT_LAUNCHER_CLASS}>
      <Button
        variant="primary"
        size="large"
        shape="circle"
        iconOnly
        icon={
          <HugeiconsIcon
            icon={BubbleChatIcon}
            data-icon="message-circle"
            size={HEADER_ICON_SIZE.md}
            strokeWidth={1.9}
          />
        }
        onClick={onOpen}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        data-testid="side-chat-floating-button"
        className="pointer-events-auto shadow-lg"
      />
    </div>
  );
}

const ChatPanelSideChat: React.FC<ChatPanelSideChatProps> = ({
  SessionCreatorSlot,
}) => {
  const { t } = useTranslation("sessions");
  const visible = useAtomValue(sideChatVisibleAtom);
  const activeTabType = useAtomValue(activeChatPanelTabTypeAtom);
  const openSideChat = useSetAtom(openSideChatAtom);
  const handleOpen = useCallback(() => openSideChat(null), [openSideChat]);
  if (!visible) {
    // Launchpad and session surfaces already own a composer — no launcher.
    return shouldShowSideChatLauncher(activeTabType) ? (
      <SideChatLauncher label={t("chat.sideChat.title")} onOpen={handleOpen} />
    ) : null;
  }
  return <SideChatWindow SessionCreatorSlot={SessionCreatorSlot} />;
};

const SideChatWindow: React.FC<ChatPanelSideChatProps> = ({
  SessionCreatorSlot,
}) => {
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");
  const [sessionId, setSessionId] = useAtom(sideChatSessionIdAtom);
  const closeSideChat = useSetAtom(closeSideChatAtom);
  const openSessionTab = useSetAtom(openOrFocusSessionInChatPanelTabAtom);
  const chatVisible = useAtomValue(chatVisibleAtom);
  const restoreChatWidth = useSetAtom(restoreChatWidthAtom);
  const sessionMap = useAtomValue(sessionMapAtom);
  const session = sessionId ? sessionMap.get(sessionId) : undefined;

  const sessionName =
    session?.name && session.name !== SESSION_CONFIG.DEFAULT_SESSION_NAME
      ? session.name
      : undefined;
  const title = sessionId
    ? sessionName ||
      stripPillReferences(session?.user_input ?? "") ||
      t("chat.sideChat.title")
    : t("chat.newSession");

  const handleNewSession = useCallback(() => {
    setSessionId(null);
  }, [setSessionId]);

  const handleOpenInTab = useCallback(() => {
    if (!sessionId) return;
    openSessionTab({ sessionId });
    // The side chat floats globally, so the chat pane may be collapsed
    // (station-only view); reopen it or the promoted tab would be invisible.
    if (!chatVisible) restoreChatWidth();
    closeSideChat();
  }, [chatVisible, closeSideChat, openSessionTab, restoreChatWidth, sessionId]);

  const handleSessionStart = useCallback(
    (info: { sessionId: string }) => {
      setSessionId(info.sessionId);
    },
    [setSessionId]
  );

  return (
    <FloatingWindow
      overlayClassName={SIDE_CHAT_OVERLAY_CLASS}
      surfaceClassName={SIDE_CHAT_SURFACE_CLASS}
      minWidth={SIDE_CHAT_MIN_WIDTH}
      minHeight={SIDE_CHAT_MIN_HEIGHT}
      maxWidth={SIDE_CHAT_MAX_WIDTH}
      maxHeight={SIDE_CHAT_MAX_HEIGHT}
    >
      <DetailPanelHeader
        title={title}
        draggable
        onClose={closeSideChat}
        actions={
          sessionId ? (
            <div className="flex items-center gap-1.5">
              <button
                className={HEADER_BUTTON.action}
                onClick={handleOpenInTab}
                title={tCommon("actions.openInNewTab")}
                aria-label={tCommon("actions.openInNewTab")}
              >
                <HugeiconsIcon
                  icon={LinkSquare02Icon}
                  data-icon="link-square-02"
                  size={HEADER_ICON_SIZE.sm}
                />
              </button>
              <button
                className={HEADER_BUTTON.action}
                onClick={handleNewSession}
                title={t("chat.newSession")}
              >
                <HugeiconsIcon
                  icon={PencilEdit02Icon}
                  data-icon="square-pen"
                  size={HEADER_ICON_SIZE.sm}
                />
              </button>
            </div>
          ) : undefined
        }
      />
      {sessionId ? (
        <SideChatSessionBody
          key={sessionId}
          sessionId={sessionId}
          isLive={isSessionInProgress(session?.status)}
        />
      ) : SessionCreatorSlot ? (
        // Same launcher format as the chat pane start page: `launchpad`
        // layout brings the centered agent hero and the glowing
        // `composer-breathing` shell, and forces dropdowns upward.
        // `hideWorkItemAttachmentControl` (with no `heroFooterSlot`) drops
        // the launchpad action-card grid — no room for it in this window.
        // The creator shares the same compact horizontal gutter as the
        // in-chat composer, so this small floating surface needs no override.
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <SessionCreatorSlot
            className="h-full min-h-0"
            layout="launchpad"
            hidePresenceButton
            hideWorkItemAttachmentControl
            launchMode="start_background"
            onSessionStart={handleSessionStart}
          />
        </div>
      ) : null}
    </FloatingWindow>
  );
};

interface SideChatSessionBodyProps {
  sessionId: string;
  isLive: boolean;
}

const SideChatSessionBody: React.FC<SideChatSessionBodyProps> = ({
  sessionId,
  isLive,
}) => {
  const turnPaginationEnabled = useAtomValue(chatTurnPaginationEnabledAtom);

  const handleSubmit = useCallback(
    async ({
      displayText,
      agentContent,
      imageDataUrls,
    }: SubmitOverrideInput): Promise<boolean> => {
      const content = agentContent ?? displayText;
      if (!content.trim()) return false;
      try {
        await SessionService.sendMessage({
          sessionId,
          content,
          displayText,
          imageDataUrls,
          turnIntentSource: "user_submit",
          directUserIntent: true,
        });
        return true;
      } catch (error) {
        log.error(`Failed to send side-chat message to ${sessionId}:`, error);
        return false;
      }
    },
    [sessionId]
  );

  return (
    <ChatSessionContext.Provider value={sessionId}>
      <ChatProvider>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatHistory
              surfaceBgClass="bg-bg-2"
              turnPaginationEnabled={turnPaginationEnabled}
              planningIndicatorScope={{ sessionId, isLive }}
            />
          </div>
          <div className="shrink-0 px-1.5 pb-1.5 pt-0.5">
            <InputArea
              key={sessionId}
              omitChatHeader
              bottomAnchored
              sessionId={sessionId}
              sessionScope="none"
              onSubmitOverride={handleSubmit}
              disableStopWhenEmpty
              showAgentControls={false}
              allowFileAttachments={false}
              enableAgentInterceptors={false}
            />
          </div>
        </div>
      </ChatProvider>
    </ChatSessionContext.Provider>
  );
};

export default ChatPanelSideChat;
