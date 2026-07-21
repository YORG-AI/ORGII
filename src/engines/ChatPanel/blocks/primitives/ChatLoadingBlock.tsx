import React, { memo } from "react";

/** Shared text-free loading placeholder for chat transcript content. */
const ChatLoadingBlock: React.FC = memo(() => (
  <div
    aria-hidden="true"
    className="h-8 w-full animate-pulse rounded bg-fill-2"
    data-testid="chat-loading-block"
  />
));

ChatLoadingBlock.displayName = "ChatLoadingBlock";

export default ChatLoadingBlock;
