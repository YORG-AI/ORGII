import { ClipboardCheck } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  CHAT_BUBBLE_WIDTH_TOKENS,
  ChatBubbleCopyButton,
} from "@src/components/ChatBubble";
import { ChatImageThumbnailRow } from "@src/components/ChatImageThumbnail";
import UserMessageContent from "@src/engines/ChatPanel/ChatHistory/components/UserMessageContent";
import { stripExpandedPillContent } from "@src/engines/ChatPanel/InputArea/utils/pillContentParser";

import { computeUserBubbleLayout } from "../userBubbleLayout";

const PLAN_APPROVED_PREFIX = "[Plan approved";

export const UserBubbleContent: React.FC<{
  content: string;
  images?: string[];
}> = memo(({ content, images }) => {
  const { t } = useTranslation("sessions");

  const isPlanApproved = content.startsWith(PLAN_APPROVED_PREFIX);
  const planApprovedEdited =
    isPlanApproved && content.startsWith("[Plan approved (edited)");

  // Strip the auto-expanded pill content block appended by the Rust pill_resolver
  // (everything after "\n\n---\n**Referenced content (auto-expanded):**") so the raw
  // referenced content doesn't leak into the inline text bubble. The persisted
  // reference tokens themselves stay present so UserMessageContent can project
  // them to ordinary links or session cards.
  const strippedContent = useMemo(
    () => stripExpandedPillContent(content).trim(),
    [content]
  );

  const { hasImages, hasContent, showBubble, imageRowNeedsGap } =
    computeUserBubbleLayout(strippedContent, images);

  if (isPlanApproved) {
    return (
      <div className="flex flex-col items-start gap-1.5 text-left">
        <div
          className={`${CHAT_BUBBLE_WIDTH_TOKENS.userBody} group/replay-msg relative rounded-lg bg-primary-1 p-3`}
        >
          <ChatBubbleCopyButton content={content} />
          <div className="flex items-center gap-2">
            <ClipboardCheck size={14} className="text-primary-6" />
            <span className="text-[13px] font-medium text-text-1">
              {planApprovedEdited
                ? t(
                    "chat.planApprovedEditedLabel",
                    "Implementing approved plan (edited)"
                  )
                : t("chat.planApprovedLabel", "Implementing approved plan")}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (!hasContent && !hasImages) return null;

  return (
    <div className="flex flex-col items-start gap-1.5 text-left">
      {showBubble && (
        <div
          className={`${CHAT_BUBBLE_WIDTH_TOKENS.userBody} group/replay-msg relative rounded-lg bg-primary-1 p-3`}
        >
          <ChatBubbleCopyButton content={strippedContent} />
          {hasImages && images && (
            <div className={imageRowNeedsGap ? "mb-2" : ""}>
              <ChatImageThumbnailRow images={images} />
            </div>
          )}
          {hasContent && <UserMessageContent text={strippedContent} />}
        </div>
      )}
    </div>
  );
});
UserBubbleContent.displayName = "UserBubbleContent";
