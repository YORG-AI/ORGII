import { useAtomValue } from "jotai";
import React from "react";

import {
  CHAT_ITEM_GAP,
  CHAT_ITEM_PADDING_X,
} from "@src/engines/ChatPanel/blocks/primitives/config";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/modules/shared/layouts/blocks";
import {
  chatCodeFontSizeAtom,
  chatFontSizeAtom,
  chatLineHeightAtom,
} from "@src/store/config/configAtom";

function ChatTypographyScope({ children }: { children: React.ReactNode }) {
  const chatFontSize = useAtomValue(chatFontSizeAtom);
  const chatCodeFontSize = useAtomValue(chatCodeFontSizeAtom);
  const chatLineHeight = useAtomValue(chatLineHeightAtom);
  const lineHeightResolved = chatLineHeight ?? 1.6;

  return (
    <div
      className="wp__chat__history w-full max-w-full min-w-0 overflow-x-hidden"
      style={
        {
          fontSize: `${chatFontSize}px`,
          lineHeight: lineHeightResolved,
          "--chat-font-size": `${chatFontSize}px`,
          "--chat-code-font-size": `${chatCodeFontSize ?? 13}px`,
          "--chat-line-height": lineHeightResolved,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}

function ChatPanelPaddedRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`chat-font-size-wrapper allow-select-deep ${CHAT_ITEM_GAP} ${CHAT_ITEM_PADDING_X} ${CHAT_PANEL_WIDTH_TOKENS.contentWidth} w-full min-w-0`}
    >
      {children}
    </div>
  );
}

export function PlaygroundPreviewShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="tool-event-preview-shell tool-event-preview-shell--chat">
      <div className="tool-event-preview-shell__content tool-event-preview-shell__content--chat">
        {children}
      </div>
    </div>
  );
}

export function ChatPreviewShell({ children }: { children: React.ReactNode }) {
  return (
    <PlaygroundPreviewShell>
      <ChatTypographyScope>{children}</ChatTypographyScope>
    </PlaygroundPreviewShell>
  );
}

export { ChatPanelPaddedRow };
