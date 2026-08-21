import React from "react";

import { getCollapsedSidebarChromeOffset } from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { CollapsedSidebarButton } from "@src/scaffold/NavigationSidebar/CollapsedSidebarButton";
import { isWindows } from "@src/util/platform/tauri";

import {
  CHAT_PANEL_HEADER_DRAG_STYLE,
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
} from "./ChatPanelHeaderPrimitives";
import { ChatPanelPublishedHeader } from "./ChatPanelPublishedHeader";
import {
  CHAT_PANEL_GLASS_SURFACE_CLASS,
  CHAT_PANEL_HEADER_STACK_HEIGHT_PX,
  CHAT_PANEL_TAB_HEADER_HEIGHT_PX,
} from "./chatPanelHeaderLayout";
import type { ChatPanelHeaderSlots } from "./chatPanelHeaderSlots";

export interface ChatPanelChromeProps {
  tabStrip: React.ReactNode;
  toolbar?: React.ReactNode;
  publishedHeaderSlots?: ChatPanelHeaderSlots | null;
  overlayPublishedHeader?: boolean;
  shouldOffsetHeaderForCollapsedSidebar?: boolean;
}

/**
 * Platform-neutral presentation frame shared by the live desktop ChatPanel
 * and read-only transcript hosts. State ownership stays with each host; this
 * component owns only the canonical glass, tab row and published-header layout.
 */
export function ChatPanelChrome({
  tabStrip,
  toolbar,
  publishedHeaderSlots = null,
  overlayPublishedHeader = false,
  shouldOffsetHeaderForCollapsedSidebar = false,
}: ChatPanelChromeProps): React.ReactNode {
  const windowsHost = isWindows();

  return (
    <>
      <div
        className={`pointer-events-none absolute left-0 right-0 top-0 z-30 ${CHAT_PANEL_GLASS_SURFACE_CLASS}`}
        data-testid="chat-panel-header-glass"
        aria-hidden
        style={{
          height: publishedHeaderSlots
            ? CHAT_PANEL_HEADER_STACK_HEIGHT_PX
            : CHAT_PANEL_TAB_HEADER_HEIGHT_PX,
        }}
      />
      <div
        className={`workspace-header header-tab-group z-40 flex h-11 min-h-11 items-center gap-1.5 pl-2 pr-[7px] pt-2 ${
          overlayPublishedHeader
            ? "absolute left-0 right-0 top-0"
            : "relative flex-shrink-0"
        }`}
        data-testid="chat-panel-header"
        data-tauri-drag-region={windowsHost ? undefined : true}
        style={
          {
            paddingLeft: shouldOffsetHeaderForCollapsedSidebar
              ? getCollapsedSidebarChromeOffset()
              : undefined,
            ...(windowsHost
              ? CHAT_PANEL_HEADER_NO_DRAG_STYLE
              : CHAT_PANEL_HEADER_DRAG_STYLE),
          } as React.CSSProperties
        }
      >
        {shouldOffsetHeaderForCollapsedSidebar ? (
          <div style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}>
            <CollapsedSidebarButton />
          </div>
        ) : null}
        {tabStrip}
        {toolbar}
      </div>
      {overlayPublishedHeader && publishedHeaderSlots ? (
        <div className="absolute left-0 right-0 top-11 z-40">
          <ChatPanelPublishedHeader
            slots={publishedHeaderSlots}
            windowsHost={windowsHost}
          />
        </div>
      ) : (
        <ChatPanelPublishedHeader
          slots={publishedHeaderSlots}
          windowsHost={windowsHost}
        />
      )}
    </>
  );
}
