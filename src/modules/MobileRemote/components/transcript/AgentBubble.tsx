import React from "react";

import { ChatAssistantMessageBody } from "@src/components/ChatBubble";

import PortableAgentMessageContent from "./PortableAgentMessageContent";

export interface AgentBubbleProps {
  text: string;
  streaming?: boolean;
}

export function AgentBubble({ text, streaming }: AgentBubbleProps) {
  return (
    <ChatAssistantMessageBody
      testId="mobile-agent-message"
      className="text-left"
    >
      <PortableAgentMessageContent text={text} />
      {streaming ? <span className="ml-1 animate-pulse">▍</span> : null}
    </ChatAssistantMessageBody>
  );
}

AgentBubble.displayName = "AgentBubble";
