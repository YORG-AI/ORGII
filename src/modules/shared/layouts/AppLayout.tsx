/**
 * AppLayout Component
 *
 * Consolidated shared layout for all Orgii pages.
 * Handles sidebar, content, and optional chat panel.
 *
 * Chat and workbench content use the single Modern layout: flex siblings with
 * flat, edge-to-edge surfaces.
 *
 * Performance Architecture:
 * - Sidebar: DYNAMIC (changes per route via prop)
 * - Content: DYNAMIC (via children)
 * - ChatPanel: STABLE layer - stays mounted across view switches
 */
import { HoverSidebar } from "@/src/scaffold/NavigationSidebar";
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useRef } from "react";

import { ActionSystemProvider } from "@src/ActionSystem";
import { sendAdeActionResult } from "@src/api/tauri/agent";
import { WindowsTopBar } from "@src/components/WindowChrome";
import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import { DataProvider } from "@src/contexts/workspace/DataContext";
import ChatPanel from "@src/engines/ChatPanel";
import {
  CHAT_WIDTH_CSS_VAR,
  clampChatWidth,
} from "@src/engines/ChatPanel/config";
import type { SessionLaunchSuccessInfo } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { pendingSessionProposal } from "@src/engines/SessionCore/hooks/useAgentADEActions";
import SessionSyncProvider from "@src/engines/SessionCore/sync/SessionSyncProvider";
import { SessionCreatorChatPanel } from "@src/features/SessionCreator/variants";
import type { SessionCreatorChatPanelProps } from "@src/features/SessionCreator/variants/ChatPanel";
import { dispatchWebviewLayoutChanged } from "@src/hooks/platform/useInlineWebview/webviewLayoutEvents";
import GlobalSessionSync from "@src/modules/shared/components/GlobalSessionSync";
import { GlobalSpotlightPortal } from "@src/modules/shared/components/GlobalSpotlightPortal";
import {
  PANE_WIDTH_TRANSITION_CLASSES,
  getChatPanelBackgroundStyle,
  getChatSlotLayoutStyle,
  getPagePanelBackgroundStyle,
  getWorkbenchLayoutStyle,
} from "@src/modules/shared/layouts/viewContainerTokens";
import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import {
  type ChatPanelMode,
  DEFAULT_CHAT_WIDTH,
  chatPanelDraggingAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import type { ChatPanelPosition } from "@src/store/ui/workStationLayout/chatPositionAtoms";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import { isWindows } from "@src/util/platform/tauri";

import { GlobalModals } from "./GlobalModals";
import { MainContentArea } from "./MainContentArea";

const SettingsSlot = React.lazy(
  () =>
    import(
      /* webpackChunkName: "settings-slot" */ "@src/modules/MainApp/Settings/SettingsSlot"
    )
);

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
  /** Current window viewport width shared with the embedded Chat Panel. */
  viewportWidth: number | undefined;
  /** Sidebar component to render (null = no sidebar) */
  sidebar?: React.ReactNode;

  /** Floating sidebar (shown when hovering over collapsed sidebar area) */
  floatingSidebar?: React.ReactNode;

  /** Whether to show the built-in chat panel (default: false) */
  showChatPanel?: boolean;

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
  viewportWidth,
  sidebar,
  floatingSidebar,
  showChatPanel = false,
  chatPosition = "right",
  chatPanelMaximized = false,
  chatPanelMode = "session",
  sessionSidebarWidth: _sessionSidebarWidth = 0,
  children,
}) => {
  const rawChatWidth = useAtomValue(chatWidthAtom);
  const isChatPanelDragging = useAtomValue(chatPanelDraggingAtom);
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const chatSlotRef = useRef<HTMLDivElement>(null);
  // Settings-in-slot must always have a usable width even if the user
  // previously dragged the chat to zero. Fall back to the configured
  // default so opening Settings never produces a collapsed slot.
  const isSettingsSlot = chatPanelMode === "settings";
  const effectiveRawWidth =
    rawChatWidth > 0 ? rawChatWidth : isSettingsSlot ? DEFAULT_CHAT_WIDTH : 0;
  const chatWidth = clampChatWidth(effectiveRawWidth, viewportWidth);
  const chatWidthStyleValue = chatWidth > 0 ? `var(${CHAT_WIDTH_CSS_VAR})` : 0;
  const isChatOnLeft = chatPosition === "left";
  const isChatVisible = chatPanelMaximized || (showChatPanel && chatWidth > 0);
  // Settings doesn't have a "session" to render — when the slot is in
  // settings mode it must always be visible regardless of `chatWidth`
  // (otherwise an existing zero-width chat would hide the settings panel
  // too).
  const isSlotVisible = chatPanelMode === "settings" ? true : isChatVisible;
  // Keep the chat mounted at zero width while the workstation route owns the
  // slot. This lets close/open animate without keeping the heavy panel alive
  // on unrelated routes.
  const shouldMountSlot = isSettingsSlot || showChatPanel || chatPanelMaximized;
  const settingsSurfaceStyle = getPagePanelBackgroundStyle(
    backgroundConfig.pageOpacity
  );
  const chatPanelSurfaceStyle = getChatPanelBackgroundStyle(
    backgroundConfig.pageOpacity
  );
  const paneUnderlayStyle: React.CSSProperties = {
    backgroundColor: chatPanelSurfaceStyle.backgroundColor,
  };
  const paneTransitionClassName = isChatPanelDragging
    ? ""
    : PANE_WIDTH_TRANSITION_CLASSES;
  const chatSlotStyle = getChatSlotLayoutStyle({
    maximized: chatPanelMaximized,
    visible: isSlotVisible,
    visibleWidth: chatWidthStyleValue,
  });
  const workbenchStyle = getWorkbenchLayoutStyle(chatPanelMaximized);
  const handlePaneTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.currentTarget !== event.target) return;
      dispatchWebviewLayoutChanged();
    },
    []
  );

  useEffect(() => {
    dispatchWebviewLayoutChanged();
  }, [chatPosition, chatPanelMaximized, chatWidth, isSlotVisible]);

  useEffect(() => {
    if (isSlotVisible) return;
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      chatSlotRef.current?.contains(activeElement)
    ) {
      activeElement.blur();
    }
  }, [isSlotVisible]);

  // Slot content: either the live chat panel or the in-slot Settings surface.
  // Both share the slot's outer maximize/inset behaviour — only the inner
  // component differs.
  const slotInner =
    chatPanelMode === "settings" ? (
      <React.Suspense
        fallback={
          <div
            data-settings-loading-surface
            className="h-full w-full"
            style={settingsSurfaceStyle}
          />
        }
      >
        <SettingsSlot
          maximized={chatPanelMaximized}
          position={chatPosition}
          embedded
        />
      </React.Suspense>
    ) : (
      <ChatPanel
        viewportWidth={viewportWidth}
        embedded
        active={showChatPanel}
        useExternalWidth={chatPanelMaximized}
        position={chatPosition}
        sessionCreatorSlot={AdeAwareSessionCreatorSlot}
      />
    );

  const chatSlot = shouldMountSlot ? (
    <div
      key="chat-slot"
      ref={chatSlotRef}
      className={`relative z-10 flex min-h-0 min-w-0 overflow-hidden ${paneTransitionClassName}`}
      style={chatSlotStyle}
      aria-hidden={!isSlotVisible}
      data-fullmode-chat-wrapper
      data-tour-target={
        chatPanelMode === "session"
          ? GENERAL_LAYOUT_TOUR_TARGETS.chatPanel
          : undefined
      }
      data-chat-focus={chatPanelMaximized || undefined}
      data-chat-slot-mode={chatPanelMode}
      onTransitionEnd={handlePaneTransitionEnd}
    >
      {slotInner}
    </div>
  ) : null;

  // Shared content wrapped in providers
  const contentArea = (
    <DataProvider>
      <ChatProvider>
        <SessionSyncProvider>
          <GlobalSessionSync />

          <div
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            data-main-content
          >
            <div
              className="relative isolate flex h-full min-h-0 min-w-0 flex-row overflow-hidden"
              style={paneUnderlayStyle}
              data-pane-surface-underlay
            >
              {isChatOnLeft && chatSlot}
              <div
                key="workbench-surface"
                // Animate the real flex track to zero so inline native
                // webviews and ResizeObserver consumers see the exact width
                // throughout focus/unfocus instead of an overlay swap.
                className={`relative z-0 h-full min-h-0 min-w-0 overflow-hidden ${paneTransitionClassName}`}
                style={workbenchStyle}
                aria-hidden={chatPanelMaximized}
                data-workbench-surface
                onTransitionEnd={handlePaneTransitionEnd}
              >
                <WorkbenchActionSystemScope>
                  {children}
                </WorkbenchActionSystemScope>
              </div>
              {!isChatOnLeft && chatSlot}
            </div>
          </div>
        </SessionSyncProvider>
      </ChatProvider>
    </DataProvider>
  );

  const windowsHost = isWindows();

  return (
    <div className="relative z-10 flex h-full min-w-0 flex-1 flex-col">
      {windowsHost && <WindowsTopBar />}
      <div className="flex min-h-0 min-w-0 flex-1">
        <HoverSidebar.Trigger />
        {sidebar}

        {floatingSidebar && (
          <HoverSidebar.Container>{floatingSidebar}</HoverSidebar.Container>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MainContentArea
            className={`relative min-h-0 flex-1 ${
              windowsHost ? "windows-main-page-surface" : ""
            }`}
          >
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
