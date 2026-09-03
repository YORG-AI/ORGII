import React, { memo, useMemo } from "react";

import {
  normalizeMarkdownReferencePills,
  parseNormalizedUserMessage,
} from "@src/engines/ChatPanel/ChatHistory/components/userMessageSegments";
import { normalizeUserMessageText } from "@src/engines/ChatPanel/ChatItems/normalizeUserMessageText";

export interface PortableUserMessageContentProps {
  text: string;
}

/**
 * Mobile projection of the desktop user-message format.
 *
 * It shares desktop's envelope and pill parsers, but deliberately renders
 * desktop-only references as readable labels instead of wiring Tauri actions
 * into a normal web page.
 */
const PortableUserMessageContent: React.FC<PortableUserMessageContentProps> =
  memo(({ text }) => {
    const segments = useMemo(
      () =>
        parseNormalizedUserMessage(
          normalizeMarkdownReferencePills(normalizeUserMessageText(text))
        ),
      [text]
    );

    return (
      <span className="leading-relaxed break-words whitespace-pre-wrap text-text-1">
        {segments.map((segment, index) => {
          if (segment.kind === "text") {
            return <React.Fragment key={index}>{segment.text}</React.Fragment>;
          }

          if (segment.kind === "pill" && /^https?:\/\//iu.test(segment.path)) {
            return (
              <a
                key={index}
                href={segment.path}
                target="_blank"
                rel="noreferrer"
                className="text-primary-6 underline-offset-2 hover:underline"
              >
                {segment.displayName}
              </a>
            );
          }

          return (
            <span key={index} className="font-medium text-text-1">
              {segment.displayName}
            </span>
          );
        })}
      </span>
    );
  });

PortableUserMessageContent.displayName = "PortableUserMessageContent";

export default PortableUserMessageContent;
