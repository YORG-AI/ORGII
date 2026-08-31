import React, { useMemo } from "react";

import { ChatAssistantMessageBody } from "@src/components/ChatBubble";
import { normalizeAssistantMessageText } from "@src/engines/ChatPanel/ChatItems/normalizeAssistantMessageText";

import PortableMarkdown from "./PortableMarkdown";

export interface AgentBubbleProps {
  text: string;
  streaming?: boolean;
}

export function AgentBubble({ text, streaming }: AgentBubbleProps) {
  const normalizedText = useMemo(
    () => normalizeAssistantMessageText(text),
    [text]
  );

  return (
    <ChatAssistantMessageBody
      testId="mobile-agent-message"
      className="text-left"
    >
      <PortableMarkdown textContent={normalizedText} />
      {streaming ? <span className="ml-1 animate-pulse">▍</span> : null}
    </ChatAssistantMessageBody>
  );
}

AgentBubble.displayName = "AgentBubble";
