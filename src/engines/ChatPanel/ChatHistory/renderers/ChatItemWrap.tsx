/**
 * Unified Chat Item Wrapper
 *
 * Centralizes spacing (gap + padding) so every item type
 * uses the same tokens. Change spacing here → changes everywhere.
 */
import React from "react";

import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";
import {
  CHAT_ITEM_GAP,
  CHAT_ITEM_PADDING_X,
  CHAT_ITEM_TEXT_PADDING_X,
} from "@src/engines/ChatPanel/blocks/primitives/config";

/**
 * @param variant - "default" and "text" both use standard px-3 padding for consistent alignment
 * @param className - Extra classes (e.g. "w-full", "space-y-1")
 */
const ChatItemWrap: React.FC<{
  children: React.ReactNode;
  variant?: "default" | "text";
  className?: string;
  dataAttr?: Record<string, string | number>;
}> = ({ children, variant = "default", className = "", dataAttr }) => {
  const px =
    variant === "text" ? CHAT_ITEM_TEXT_PADDING_X : CHAT_ITEM_PADDING_X;
  return (
    <div
      className={`chat-font-size-wrapper allow-select-deep ${CHAT_ITEM_GAP} ${px} ${CHAT_PANEL_WIDTH_TOKENS.contentWidth} ${className}`.trim()}
      {...dataAttr}
    >
      {children}
    </div>
  );
};

export default ChatItemWrap;
