/**
 * AppLayout Component
 *
 * Consolidated shared layout for all Orgii pages.
 * Handles sidebar, content, and optional chat panel.
 *
 * Chat panel rendering uses a single code path for both layout methods:
 * - "inset":   ChatPanel uses position:absolute + padding offset (rounded corners)
 * - "full":    ChatPanel is a flex sibling of content (padded + rounded when
 *              sidebar is visible; edge-to-edge when sidebar collapsed)
 * - "compact": ChatPanel is a flex sibling of content, no padding, no radius
 *              regardless of sidebar state (Cursor Agent-style chrome)
 *
 * Performance Architecture:
 * - Sidebar: DYNAMIC (changes per route via prop)
 * - Content: DYNAMIC (via children)
 * - ChatPanel: STABLE layer - stays mounted across view switches
 */
import { HoverSidebar } from "@/src/scaffold/NavigationSidebar";
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useMemo } from "react";

import { ActionSystemProvider } from "@src/ActionSystem";
import { sendAdeActionResult } from "@src/api/tauri/agent";
import { WindowsTopBar } from "@src/components/WindowChrome";
import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import { DataProvider } from "@src/contexts/workspace/DataContext";
import ChatPanel from "@src/engines/ChatPanel";
import { MAX_WIDTH as CHAT_MAX_WIDTH } from "@src/engines/ChatPanel/config";
import type { SessionLaunchSuccessInfo } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { pendingSessionProposal } from "@src/engines/SessionCore/hooks/useAgentADEActions";
import SessionSyncProvider from "@src/engines/SessionCore/sync/SessionSyncProvider";
import { SessionCreatorChatPanel } from "@src/features/SessionCreator/variants";
import type { SessionCreatorChatPanelProps } from "@src/features/SessionCreator/variants/ChatPanel";
import { dispatchWebviewLayoutChanged } from "@src/hooks/platform/useInlineWebview/webviewLayoutEvents";
import SettingsSlot from "@src/modules/MainApp/Settings/SettingsSlot";
import GlobalSessionSync from "@src/modules/shared/components/GlobalSessionSync";
import { GlobalSpotlightPortal } from "@src/modules/shared/components/GlobalSpotlightPortal";
import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/GeneralLayoutTour";
import {
  type ChatPanelMode,
  DEFAULT_CHAT_WIDTH,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import type { ChatPanelPosition } from "@src/store/ui/workStationLayout/chatPositionAtoms";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import { isWindows } from "@src/util/platform/tauri";

import { FocusedChatWorkstationRail } from "./FocusedChatWorkstationRail";
import { GlobalModals } from "./GlobalModals";
import { MainContentArea } from "./MainContentArea";

export type ChatLayout = "inset" | "full" | "compact";

// ============================================
// ADE-aware session creator slot
// ============================================

/**
 * Thin wrapper around SessionCreatorChatPanel. When there is a pending ADE
 * session.propose, launching from the creator directly resolves the Rust-side
 * tool call via sendAdeActionResult — no custom events, no Zod actions.
 */
const AdeAwareSessionCreatorSlot: React.FC<SessionCreatorChatPanelProps> = (
  props
) => {
  const handleSessionStart = useCallback(
    (info: SessionLaunchSuccessInfo) => {
      const proposal = pendingSessionProposal.current;
      if (proposal) {
        pendingSessionProposal.current = null;
        void sendAdeActionResult(proposal.correlationId, {
          success: true,
          message: `Session created: ${info.sessionId}`,
          data: { sessionId: info.sessionId },
        });
        // Dismiss the countdown card in the ADE palette.
        window.dispatchEvent(
          new CustomEvent("ade-session-proposal-resolved", {
            detail: { correlationId: proposal.correlationId },
          })
        );
      }
      props.onSessionStart?.(info);
    },
    [props]
  );

  return (
    <SessionCreatorChatPanel {...props} onSessionStart={handleSessionStart} />
  );
};

function WorkbenchActionSystemScope({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  const repoPath = useAtomValue(activeWorkspaceRootPathAtom);

  return (
    <ActionSystemProvider repoPath={repoPath}>
      {children}
      <GlobalSpotlightPortal />
    </ActionSystemProvider>
  );
}

// ============================================
// Types
// ============================================

export interface AppLayoutProps {
  /** Sidebar component to render (null = no sidebar) */
  sidebar?: React.ReactNode;

  /** Floating sidebar (shown when hovering over collapsed sidebar area) */
  floatingSidebar?: React.ReactNode;

  /** Whether to show the built-in chat panel (default: false) */
  showChatPanel?: boolean;

  /** Whether to apply content padding (for code/session views, default: false) */
  contentPadding?: boolean;

  /**
   * How the chat panel is laid out relative to content.
   * - "inset":   absolute overlay with padding offset (default)
   * - "full":    flex sibling, padded + rounded when sidebar visible,
   *              edge-to-edge when sidebar collapsed
   * - "compact": flex sibling, no padding, no radius (Cursor Agent style)
   */
  chatLayout?: ChatLayout;

  /** Chat panel position ("left" or "right"). */
  chatPosition?: ChatPanelPosition;

  /**
   * When true, the docked chat-panel slot takes over the entire main content
   * area (the `children` view is hidden behind a zero-width workbench
   * surface). Used by the chat-panel maximize button, the narrow-viewport
   * auto-flip, and the Settings-in-slot variant.
   */
  chatPanelMaximized?: boolean;

  /**
   * What content occupies the chat-panel slot — the live session
   * (`"session"`) or the embedded Settings surface (`"settings"`). Drives
   * which component the slot renders, not its layout.
   */
  chatPanelMode?: ChatPanelMode;

  /** Session sidebar width reserved by the parent layout. */
  sessionSidebarWidth?: number;

  /** Content to render in the main area */
  children: React.ReactNode;
}

// ============================================
// Component
// ============================================

const AppLayoutComponent: React.FC<AppLayoutProps> = ({
  sidebar,
  floatingSidebar,
  showChatPanel = false,
  contentPadding = false,
  chatLayout = "inset",
  chatPosition = "right",
  chatPanelMaximized = false,
  chatPanelMode = "session",
  sessionSidebarWidth: _sessionSidebarWidth = 0,
  children,
}) => {
  const rawChatWidth = useAtomValue(chatWidthAtom);
  // Settings-in-slot must always have a usable width even if the user
  // previously dragged the chat to zero. Fall back to the configured
  // default so opening Settings never produces a collapsed slot.
  const isSettingsSlot = chatPanelMode === "settings";
  const effectiveRawWidth =
    rawChatWidth > 0 ? rawChatWidth : isSettingsSlot ? DEFAULT_CHAT_WIDTH : 0;
  const chatWidth =
    effectiveRawWidth > 0
      ? Math.min(effectiveRawWidth, CHAT_MAX_WIDTH)
      : effectiveRawWidth;
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const isChatOnLeft = chatPosition === "left";
  const isCompact = chatLayout === "compact";
  // Compact also lays out chat as a flex sibling.
  const isFull = chatLayout === "full" || isCompact;
  const isChatVisible = chatPanelMaximized || (showChatPanel && chatWidth > 0);
  // Settings doesn't have a "session" to render — when the slot is in
  // settings mode it must always be visible regardless of `chatWidth`
  // (otherwise an existing zero-width chat would hide the settings panel
  // too).
  const isSlotVisible = chatPanelMode === "settings" ? true : isChatVisible;

  useEffect(() => {
    dispatchWebviewLayoutChanged();
  }, [
    chatLayout,
    chatPosition,
    chatPanelMaximized,
    chatWidth,
    isSlotVisible,
    sidebarCollapsed,
  ]);

  // Full mode is edge-to-edge only when sidebar is collapsed;
  // with sidebar visible it gets the same padding + radius as inset.
  // Compact is always edge-to-edge regardless of sidebar state.
  const needsPadding =
    !isCompact && contentPadding && !(isFull && sidebarCollapsed);
  const paddingValue = needsPadding ? 8 : 0;

  // Reserve space for the absolutely-positioned ChatPanel (inset mode only;
  // full mode uses flex siblings so chat width doesn't affect padding).
  // While the slot is maximized the panel covers the entire content area, so
  // no padding is reserved for it (the absolute panel handles its own
  // left/right insets).
  const contentStyle = useMemo(
    () =>
      isFull
        ? {
            paddingTop: paddingValue,
            paddingLeft: paddingValue,
            paddingBottom: paddingValue,
            paddingRight: paddingValue,
          }
        : {
            paddingTop: paddingValue,
            paddingLeft:
              isChatOnLeft && isSlotVisible && !chatPanelMaximized
                ? paddingValue + chatWidth + 4
                : paddingValue,
            paddingBottom: paddingValue,
            paddingRight:
              !isChatOnLeft && isSlotVisible && !chatPanelMaximized
                ? paddingValue + chatWidth + 4
                : paddingValue,
          },
    [
      paddingValue,
      isSlotVisible,
      chatWidth,
      isFull,
      chatPanelMaximized,
      isChatOnLeft,
    ]
  );

  // Inset mode: absolute overlay, hidden via opacity/transform when not visible.
  // When the slot is maximized the panel stretches edge-to-edge inside the
  // content area, covering the children view without unmounting it.
  const insetChatStyle = useMemo(
    () => ({
      position: "absolute" as const,
      top: paddingValue,
      left: chatPanelMaximized || isChatOnLeft ? paddingValue : undefined,
      right: chatPanelMaximized || !isChatOnLeft ? paddingValue : undefined,
      bottom: paddingValue,
      display: "flex",
      width: chatPanelMaximized ? undefined : chatWidth || 0,
      overflow: "visible" as const,
      opacity: isSlotVisible ? 1 : 0,
      pointerEvents: isSlotVisible ? ("auto" as const) : ("none" as const),
      transform: isSlotVisible
        ? "translateX(0)"
        : `translateX(${isChatOnLeft ? "-120%" : "120%"})`,
    }),
    [paddingValue, chatWidth, isSlotVisible, chatPanelMaximized, isChatOnLeft]
  );

  // Slot content: either the live chat panel or the in-slot Settings surface.
  // Both share the slot's outer maximize/inset behaviour — only the inner
  // component differs.
  const slotInner =
    chatPanelMode === "settings" ? (
      <SettingsSlot
        maximized={chatPanelMaximized}
        position={chatPosition}
        embedded={isFull}
      />
    ) : (
      <ChatPanel
        embedded={isFull}
        active={showChatPanel}
        useExternalWidth={chatPanelMaximized}
        position={chatPosition}
        sessionCreatorSlot={AdeAwareSessionCreatorSlot}
      />
    );

  // Shared content wrapped in providers
  const contentArea = (
    <DataProvider>
      <ChatProvider>
        <SessionSyncProvider>
          <GlobalSessionSync />

          {isFull ? (
            // Full mode: content + slot as flex siblings.
            // When maximized the slot sibling becomes an absolute overlay and
            // visually covers the children — children stay mounted (no remount
            // on focus toggle).
            <div
              className="min-h-0 min-w-0 flex-1 overflow-hidden"
              style={contentStyle}
              data-main-content
            >
              <div
                className={`relative isolate flex h-full min-h-0 min-w-0 flex-row overflow-hidden ${needsPadding ? "rounded-page" : ""}`}
              >
                {isChatOnLeft && isSlotVisible && (
                  <div
                    key="chat-slot"
                    className={
                      chatPanelMaximized
                        ? "absolute inset-0 z-10 flex min-h-0 min-w-0"
                        : "relative z-10 flex flex-shrink-0"
                    }
                    style={
                      chatPanelMaximized ? undefined : { width: chatWidth }
                    }
                    data-fullmode-chat-wrapper
                    data-tour-target={
                      chatPanelMode === "session"
                        ? GENERAL_LAYOUT_TOUR_TARGETS.chatPanel
                        : undefined
                    }
                    data-chat-focus={chatPanelMaximized || undefined}
                    data-chat-slot-mode={chatPanelMode}
                  >
                    {slotInner}
                  </div>
                )}
                <div
                  key="workbench-surface"
                  // Maximizing the slot collapses the workbench surface to
                  // zero width (instead of `flex-1`) so any inline native
                  // webview hosted inside it sees `ResizeObserver` report
                  // `0 × <height>`, and `useWebviewLayout.updatePosition`
                  // shrinks the sibling NSView to a zero-area frame. React
                  // keeps the subtree mounted; only the visible footprint
                  // goes away. Without this, the WKWebView stays at its last
                  // frame and paints above the React slot because it is a
                  // window-level sibling NSView, not a DOM child.
                  className={`relative z-0 h-full min-h-0 min-w-0 overflow-hidden ${chatPanelMaximized ? "w-0 flex-none" : "flex-1"}`}
                  data-workbench-surface
                >
                  <WorkbenchActionSystemScope>
                    {children}
                  </WorkbenchActionSystemScope>
                </div>
                {!isChatOnLeft && isSlotVisible && (
                  <div
                    key="chat-slot"
                    className={
                      chatPanelMaximized
                        ? "absolute inset-0 z-10 flex min-h-0 min-w-0"
                        : "relative z-10 flex flex-shrink-0"
                    }
                    style={
                      chatPanelMaximized ? undefined : { width: chatWidth }
                    }
                    data-fullmode-chat-wrapper
                    data-tour-target={
                      chatPanelMode === "session"
                        ? GENERAL_LAYOUT_TOUR_TARGETS.chatPanel
                        : undefined
                    }
                    data-chat-focus={chatPanelMaximized || undefined}
                    data-chat-slot-mode={chatPanelMode}
                  >
                    {slotInner}
                  </div>
                )}
                {chatPanelMaximized && chatPanelMode === "session" && (
                  <FocusedChatWorkstationRail />
                )}
              </div>
            </div>
          ) : (
            // Inset mode: absolute overlay. When maximized the overlay
            // stretches edge-to-edge (left+right insets) so it covers the
            // children view without changing the underlying layout mode.
            <div
              className="relative min-w-0 flex-1"
              style={contentStyle}
              data-main-content
            >
              <div
                // See the full-mode comment above: `w-0` while maximized
                // collapses the workbench surface so inline native webviews
                // shrink to a zero-area frame via `ResizeObserver`, instead
                // of continuing to paint behind (and through) the slot
                // overlay as window-level sibling NSViews.
                className={`relative h-full min-h-0 min-w-0 ${chatPanelMaximized ? "w-0" : "w-full"}`}
                data-workbench-surface
              >
                <WorkbenchActionSystemScope>
                  {children}
                </WorkbenchActionSystemScope>
              </div>
              <div
                style={insetChatStyle}
                data-tour-target={
                  chatPanelMode === "session"
                    ? GENERAL_LAYOUT_TOUR_TARGETS.chatPanel
                    : undefined
                }
                data-chat-focus={chatPanelMaximized || undefined}
                data-chat-slot-mode={chatPanelMode}
              >
                {slotInner}
              </div>
              {chatPanelMaximized && chatPanelMode === "session" && (
                <FocusedChatWorkstationRail />
              )}
            </div>
          )}
        </SessionSyncProvider>
      </ChatProvider>
    </DataProvider>
  );

  const windowsHost = isWindows();

  return (
    <div className="relative z-10 flex h-full min-w-0 flex-1 flex-col bg-bg-2">
      {windowsHost && <WindowsTopBar />}
      <div className="flex min-h-0 min-w-0 flex-1">
        <HoverSidebar.Trigger />
        {sidebar}

        {floatingSidebar && (
          <HoverSidebar.Container>{floatingSidebar}</HoverSidebar.Container>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MainContentArea className="relative min-h-0 flex-1">
            {contentArea}
          </MainContentArea>

          <GlobalModals />
        </div>
      </div>
    </div>
  );
};

AppLayoutComponent.displayName = "AppLayout";

export const AppLayout = memo(AppLayoutComponent);
