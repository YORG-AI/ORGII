import React, { memo, useMemo } from "react";

import { projectPortableAgentMessageText } from "@src/engines/ChatPanel/ChatItems/projectPortableAgentMessageText";

import PortableMarkdown from "./PortableMarkdown";

export interface PortableAgentMessageContentProps {
  text: string;
}

/**
 * Mobile projection of the desktop assistant-message body.
 *
 * Applies the same think-tag and writing-block hygiene as ChatSession before
 * rendering through the browser-safe Markdown subset.
 */
const PortableAgentMessageContent: React.FC<PortableAgentMessageContentProps> =
  memo(({ text }) => {
    const projectedText = useMemo(
      () => projectPortableAgentMessageText(text),
      [text]
    );

    if (!projectedText) return null;

    return <PortableMarkdown textContent={projectedText} />;
  });

PortableAgentMessageContent.displayName = "PortableAgentMessageContent";

export default PortableAgentMessageContent;
