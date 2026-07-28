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
}

/** Chat-pane counterpart of My Station's shared 40px published header. */
export const ChatPanelPublishedHeader: React.FC<ChatPanelPublishedHeaderProps> =
  memo(({ slots, windowsHost }) => {
    if (!slots) return null;

    return (
      <div
        className={`flex h-10 shrink-0 items-center gap-2 pl-1.5 pr-2 ${
          slots.joinWithFollowingRow ? "" : "border-b border-border-2"
        }`}
        data-testid="chat-panel-published-header"
        data-tauri-drag-region={windowsHost ? undefined : true}
        style={
          windowsHost
            ? CHAT_PANEL_HEADER_NO_DRAG_STYLE
            : CHAT_PANEL_HEADER_DRAG_STYLE
        }
      >
        <PublishedHeaderSlotsView slots={slots} />
      </div>
    );
  });

ChatPanelPublishedHeader.displayName = "ChatPanelPublishedHeader";
