import React, { memo } from "react";

import { PublishedHeaderSlotsView } from "@src/components/WindowChrome";

import {
  CHAT_PANEL_HEADER_DRAG_STYLE,
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
} from "./ChatPanelHeaderPrimitives";
import type { ChatPanelHeaderSlots } from "./chatPanelHeaderSlots";

interface ChatPanelPublishedHeaderProps {
  slots: ChatPanelHeaderSlots | null;
  windowsHost: boolean;
  /**
   * Space reserved at the left edge for the host window's own controls and the
   * collapsed-sidebar button. Replaces the slot view's default text inset when
   * set, and is only passed once this row inherited the pane's top edge.
   */
  leadingInsetPx?: number;
}

/** Chat-pane counterpart of My Station's shared 36px published header. */
export const ChatPanelPublishedHeader: React.FC<ChatPanelPublishedHeaderProps> =
  memo(({ slots, windowsHost, leadingInsetPx }) => {
    if (!slots) return null;

    return (
      <div
        className={`relative z-40 flex h-9 shrink-0 items-center gap-2 pr-2 ${
          slots.joinWithFollowingRow ? "" : "border-b border-border-2"
        }`}
        data-testid="chat-panel-published-header"
        data-tauri-drag-region={windowsHost ? undefined : true}
        style={{
          ...(windowsHost
            ? CHAT_PANEL_HEADER_NO_DRAG_STYLE
            : CHAT_PANEL_HEADER_DRAG_STYLE),
          paddingLeft: leadingInsetPx,
        }}
      >
        <PublishedHeaderSlotsView
          slots={slots}
          paddingLeftClassName={leadingInsetPx === undefined ? undefined : ""}
        />
      </div>
    );
  });

ChatPanelPublishedHeader.displayName = "ChatPanelPublishedHeader";
