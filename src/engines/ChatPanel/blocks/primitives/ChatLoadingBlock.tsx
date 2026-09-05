import React, { memo } from "react";

import SkeletonBar from "@src/components/Skeleton";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";

/** Shared text-free loading placeholder for initial chat-pane content. */
const ChatLoadingBlock: React.FC = memo(() => (
  <SkeletonBar
    className={`${CHAT_PANEL_WIDTH_TOKENS.contentWidth} h-8`}
    testId="chat-loading-block"
  />
));

ChatLoadingBlock.displayName = "ChatLoadingBlock";

export default ChatLoadingBlock;
