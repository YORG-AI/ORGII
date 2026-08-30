/**
 * ChatViewPostHistoryOverlays — bottom-of-history overlays stacked above the
 * primary chat history surface: the "continue as ORGII session" composer
 * shown for imported/external history, and (when that composer isn't
 * showing) a standalone scroll-to-bottom affordance for imported history
 * views.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { getImportedHistoryCliResume } from "@src/api/tauri/externalHistory";
import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";

import {
  CHAT_SESSION_CONTEXT_NONE,
  ChatSessionContext,
} from "./ChatSessionContext";
import InputArea from "./InputArea";
import type { SubmitOverrideInput } from "./hooks/useInputArea/types";

interface ChatViewPostHistoryOverlaysProps {
  showExternalHistoryForkComposer: boolean;
  composerRef: (node: HTMLDivElement | null) => void;
  position: "left" | "right";
  onSubmitOverride: (input: SubmitOverrideInput) => Promise<boolean>;
  externalScrollToBottomButton: React.ReactNode;
  isImportedHistory: boolean;
  /** The viewed history session — Address Comments targets its threads
   * even though this composer dispatches into a fork. */
  sessionId?: string;
}

export function ChatViewPostHistoryOverlays({
  showExternalHistoryForkComposer,
  composerRef,
  position,
  onSubmitOverride,
  externalScrollToBottomButton,
  isImportedHistory,
  sessionId,
}: ChatViewPostHistoryOverlaysProps) {
  const { t: tNavigation } = useTranslation("navigation");
  // The composer only renders for CLI-continuable sources (ChatView gates
  // `showExternalHistoryForkComposer` on the same `getImportedHistoryCliResume`
  // check), so `cliResume` is always defined whenever this placeholder runs.
  const cliResume = getImportedHistoryCliResume(sessionId);
  const composerPlaceholder = tNavigation(
    "collaboration.continueCli.composerPlaceholder",
    { agent: cliResume?.displayName ?? "" }
  );

  return (
    <>
      {showExternalHistoryForkComposer && (
        <div
          ref={composerRef}
          data-testid="external-history-fork-composer"
          className={`absolute bottom-0 left-0 right-0 z-50 flex w-full flex-shrink-0 flex-col items-center px-2 pt-1 ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}`}
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[-28px] bg-gradient-to-t from-chat-pane via-chat-pane/90 to-transparent" />
          <div
            className={`${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth} relative z-10 w-full`}
          >
            <ChatSessionContext.Provider value={CHAT_SESSION_CONTEXT_NONE}>
              <InputArea
                omitChatHeader
                placeholder={composerPlaceholder}
                chatPanelPosition={position}
                sessionScope="none"
                onSubmitOverride={onSubmitOverride}
                topRowTrailingContent={externalScrollToBottomButton}
                bottomAnchored
              />
            </ChatSessionContext.Provider>
          </div>
        </div>
      )}
      {isImportedHistory &&
        !showExternalHistoryForkComposer &&
        externalScrollToBottomButton && (
          <div className="pointer-events-none absolute bottom-2 left-0 right-0 z-50">
            <div
              className={`mx-auto flex w-full justify-end px-2 ${CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth}`}
            >
              <span className="pointer-events-auto">
                {externalScrollToBottomButton}
              </span>
            </div>
          </div>
        )}
    </>
  );
}
