import React from "react";

import { InSimulatorReplayContext } from "@src/engines/ChatPanel/blocks/primitives/inSimulatorReplayContext";

import MessageViewer from "../MessageViewer";
import type { MessageViewerProps } from "../MessageViewer";

interface CommunicationMessageContentProps {
  chatFontSize: number;
  chatCodeFontSize: number | null | undefined;
  chatLineHeight: number | null | undefined;
  viewerProps: MessageViewerProps;
}

/** Owns the simulator typography bridge and replay context around MessageViewer. */
export function CommunicationMessageContent({
  chatFontSize,
  chatCodeFontSize,
  chatLineHeight,
  viewerProps,
}: CommunicationMessageContentProps) {
  const resolvedLineHeight = chatLineHeight ?? 1.6;
  return (
    <InSimulatorReplayContext.Provider value={true}>
      <div
        className="flex h-full w-full flex-col overflow-hidden"
        style={
          {
            fontSize: `${chatFontSize}px`,
            lineHeight: resolvedLineHeight,
            "--chat-font-size": `${chatFontSize}px`,
            "--chat-code-font-size": `${chatCodeFontSize ?? 13}px`,
            "--chat-line-height": resolvedLineHeight,
          } as React.CSSProperties
        }
      >
        <MessageViewer {...viewerProps} />
      </div>
    </InSimulatorReplayContext.Provider>
  );
}
