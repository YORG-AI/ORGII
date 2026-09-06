/** Standalone history affordances used only when no composer is visible. */
import React from "react";

import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";

interface ChatViewPostHistoryOverlaysProps {
  composerVisible: boolean;
  externalScrollToBottomButton: React.ReactNode;
  isImportedHistory: boolean;
}

export function ChatViewPostHistoryOverlays({
  composerVisible,
  externalScrollToBottomButton,
  isImportedHistory,
}: ChatViewPostHistoryOverlaysProps) {
  return (
    isImportedHistory &&
    !composerVisible &&
    externalScrollToBottomButton && (
      <div className="pointer-events-none absolute right-0 bottom-2 left-0 z-50">
        <div
          className={`mx-auto flex w-full justify-end px-2 ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
        >
          <span className="pointer-events-auto">
            {externalScrollToBottomButton}
          </span>
        </div>
      </div>
    )
  );
}
