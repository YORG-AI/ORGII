import React, { memo } from "react";

import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";

/** Shared text-free loading placeholder for initial chat-pane content. */
const ChatLoadingBlock: React.FC = memo(() => (
  <div
    aria-hidden="true"
    className={`${CHAT_PANEL_WIDTH_TOKENS.contentWidth} h-8 animate-pulse rounded bg-fill-2`}
    data-testid="chat-loading-block"
  />
));

ChatLoadingBlock.displayName = "ChatLoadingBlock";

export default ChatLoadingBlock;
