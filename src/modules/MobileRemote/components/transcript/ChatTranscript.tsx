import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import ChatLoadingBlock from "@src/components/ChatLoadingBlock";
import { Placeholder } from "@src/components/Placeholder";
import ScrollToBottomButton from "@src/components/ScrollToBottomButton";
import {
  CHAT_ITEM_GAP,
  CHAT_ITEM_PADDING_X,
} from "@src/engines/ChatPanel/blocks/primitives/config";

import type { TranscriptLoadPhase } from "../../lib/transcriptLoadState";
import type { TranscriptItem } from "../../lib/transcriptReducer";
import { AgentBubble } from "./AgentBubble";
import { MobileToolCall, MobileToolDetailSheet } from "./MobileToolCall";
import { UserBubble } from "./UserBubble";
import type { MobileFileTarget } from "./mobileFileTool";
import { useMobileChatScroll } from "./useMobileChatScroll";

export interface ChatTranscriptProps {
  sessionId: string;
  roundId?: string | null;
  items: TranscriptItem[];
  phase: TranscriptLoadPhase;
  error?: string;
  /** Active local turn; forces the desktop-style tail follow after submit. */
  forceFollowKey?: string;
  /** Show ChatPanel's loading block until the active turn paints output. */
  waitingForAgent?: boolean;
  onRetry: () => void;
  onOpenFile?: (eventId: string, target: MobileFileTarget) => Promise<void>;
}

export function ChatTranscript({
  sessionId,
  roundId,
  items,
  phase,
  error,
  forceFollowKey,
  waitingForAgent = false,
  onRetry,
  onOpenFile,
}: ChatTranscriptProps) {
  const { t } = useTranslation("mobileRemote");
  const transcriptScope = `${sessionId}:${roundId ?? "no-round"}`;
  const [toolDetail, setToolDetail] = useState<{
    scope: string;
    itemId: string;
    open: boolean;
  } | null>(null);
  const selectedTool =
    toolDetail?.scope === transcriptScope
      ? items.find(
          (item) => item.kind === "tool" && item.id === toolDetail.itemId
        )
      : undefined;
  const toolDetailOpen = Boolean(selectedTool && toolDetail?.open);
  const tailItem = items.at(-1);
  const tailToolDataSize =
    tailItem?.kind === "tool" && tailItem.toolData
      ? JSON.stringify(tailItem.toolData).length
      : 0;
  const contentKey = tailItem
    ? `${items.length}:${tailItem.id}:${tailItem.text.length}:${tailItem.streaming === true}:${tailItem.toolStatus ?? ""}:${tailToolDataSize}:${waitingForAgent}`
    : `empty:${waitingForAgent}`;
  const transcriptVisible =
    phase !== "error" &&
    phase !== "empty" &&
    (phase !== "loading" || items.length > 0);
  const { contentRef, scrollRef, scrollToBottom, showScrollToBottom } =
    useMobileChatScroll({
      sessionId: `${sessionId}:${roundId ?? "no-round"}`,
      contentKey,
      enabled: transcriptVisible,
      forceFollowKey,
    });

  if (phase === "error") {
    return (
      <Placeholder
        variant="error"
        placement="sidebar"
        fillParentHeight
        title={t("transcript.errorTitle")}
        subtitle={
          error
            ? t("transcript.errorDetail", { message: error })
            : t("transcript.errorSubtitle")
        }
        action={{ label: t("transcript.retry"), onClick: onRetry }}
      />
    );
  }

  if (phase === "loading" && items.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1"
        data-mobile-transcript-loading="true"
      >
        <Placeholder
          fillParentHeight
          placement="sidebar"
          title={t("transcript.loading")}
          variant="loading"
        />
      </div>
    );
  }

  if (phase === "empty") {
    return (
      <Placeholder
        variant="empty"
        placement="sidebar"
        fillParentHeight
        title={t("transcript.emptyTitle")}
        subtitle={t("transcript.emptySubtitle")}
      />
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full min-h-0 overflow-y-auto px-2 py-3"
        role="log"
        aria-live="polite"
      >
        <div ref={contentRef} className="flex w-full min-w-0 flex-col">
          {items.map((item) => {
            let content: React.ReactNode;
            if (item.kind === "user") {
              content = <UserBubble text={item.text} />;
            } else if (item.kind === "agent") {
              content = (
                <AgentBubble text={item.text} streaming={item.streaming} />
              );
            } else {
              content = (
                <MobileToolCall
                  item={item}
                  detailsOpen={toolDetailOpen && selectedTool?.id === item.id}
                  onOpenDetails={() =>
                    setToolDetail({
                      scope: transcriptScope,
                      itemId: item.id,
                      open: true,
                    })
                  }
                />
              );
            }
            return (
              <div
                key={item.id}
                className={`${CHAT_ITEM_GAP} ${CHAT_ITEM_PADDING_X}`}
                data-transcript-item-kind={item.kind}
              >
                {content}
              </div>
            );
          })}
          {waitingForAgent ? (
            <div
              className={`${CHAT_ITEM_GAP} ${CHAT_ITEM_PADDING_X}`}
              data-mobile-agent-loading="true"
            >
              <ChatLoadingBlock />
            </div>
          ) : null}
        </div>
      </div>
      {showScrollToBottom ? (
        <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
          <ScrollToBottomButton
            label={t("transcript.scrollToBottom")}
            onClick={scrollToBottom}
          />
        </div>
      ) : null}
      {selectedTool ? (
        <MobileToolDetailSheet
          key={`${transcriptScope}:${selectedTool.id}`}
          item={selectedTool}
          open={toolDetailOpen}
          onClose={() =>
            setToolDetail((current) =>
              current ? { ...current, open: false } : current
            )
          }
          onOpenFile={
            onOpenFile
              ? (target) => onOpenFile(selectedTool.id, target)
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

ChatTranscript.displayName = "ChatTranscript";
