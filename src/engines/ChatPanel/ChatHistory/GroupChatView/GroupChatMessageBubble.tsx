import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ChatBubbleBody } from "@src/components/ChatBubble";
import ClampedContent from "@src/components/ClampedContent";
import Markdown from "@src/components/MarkDown";
import PersonAvatar from "@src/components/PersonAvatar";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import type { GroupChatToolUseSummary } from "./groupChatUtils";

interface GroupChatMessageBubbleProps {
  senderName: string;
  recipientName: string | null;
  bodyMarkdown: string;
  timestamp: string;
  showSenderChrome: boolean;
  toolUseSummary?: GroupChatToolUseSummary | null;
}

function formatSummaryPart(
  translate: (key: string, options: { count: number }) => string,
  key: string,
  count: number
): string | null {
  if (count <= 0) return null;
  return translate(key, { count });
}

const GroupChatMessageBubble: React.FC<GroupChatMessageBubbleProps> = ({
  senderName,
  recipientName,
  bodyMarkdown,
  timestamp,
  showSenderChrome,
  toolUseSummary = null,
}) => {
  const { t, i18n } = useTranslation(["common", "sessions"]);
  const trimmedRecipient = recipientName?.trim() ?? null;
  const trimmedBody = bodyMarkdown.trim();
  const { firstLine, restBody } = useMemo(() => {
    if (!trimmedRecipient) return { firstLine: "", restBody: trimmedBody };
    const breakIndex = trimmedBody.search(/\r?\n/);
    if (breakIndex < 0) return { firstLine: trimmedBody, restBody: "" };
    return {
      firstLine: trimmedBody.slice(0, breakIndex),
      restBody: trimmedBody.slice(breakIndex).replace(/^\r?\n+/, ""),
    };
  }, [trimmedBody, trimmedRecipient]);

  const timestampLabel = formatSmartDateTime(timestamp, {
    yesterdayLabel: t("relativeDate.yesterday"),
    locale: toIntlLocaleTag(i18n.resolvedLanguage),
  });

  const toolUseSummaryLabel = useMemo(() => {
    if (!toolUseSummary) return null;
    const parts = [
      formatSummaryPart(
        t,
        "sessions:groupChat.toolUseSummary.readFiles",
        toolUseSummary.readFiles
      ),
      formatSummaryPart(
        t,
        "sessions:groupChat.toolUseSummary.editedFiles",
        toolUseSummary.editedFiles
      ),
      formatSummaryPart(
        t,
        "sessions:groupChat.toolUseSummary.terminalUses",
        toolUseSummary.terminalUses
      ),
      formatSummaryPart(
        t,
        "sessions:groupChat.toolUseSummary.explorations",
        toolUseSummary.explorations
      ),
      formatSummaryPart(
        t,
        "sessions:groupChat.toolUseSummary.otherTools",
        toolUseSummary.otherTools
      ),
    ].filter((part): part is string => Boolean(part));
    if (parts.length === 0) return null;
    return t("sessions:groupChat.toolUseSummary.note", {
      sender: senderName,
      summary: parts.join(" · "),
    });
  }, [senderName, t, toolUseSummary]);

  const avatar = (
    <div
      className={`flex w-8 shrink-0 items-center pl-1 ${showSenderChrome ? "h-9" : "h-0"}`}
      aria-hidden={!showSenderChrome}
    >
      {showSenderChrome && (
        <span className="inline-flex" title={senderName}>
          <PersonAvatar name={senderName} size={24} />
        </span>
      )}
    </div>
  );

  return (
    <div
      data-testid="agent-org-group-chat-message"
      data-sender-name={senderName}
      data-recipient-name={trimmedRecipient ?? ""}
      className="flex gap-1"
    >
      {avatar}
      <div className="max-w-[min(750px,100%)] min-w-0 flex-1 overflow-hidden">
        {showSenderChrome && (
          <div className="flex h-9 items-center">
            <div className="flex h-4 items-center gap-2 leading-none">
              <span className="text-[13px] leading-none font-medium text-text-1">
                {senderName}
              </span>
              <span className="text-[11px] leading-none text-text-3">
                {timestampLabel}
              </span>
            </div>
          </div>
        )}
        <ChatBubbleBody variant="neutral" className="rounded-2xl! px-3! py-2!">
          {/* Clamp long agent messages to a ~20-line preview (ClampedContent's
              default); the expand/collapse pill fades into the neutral bubble. */}
          <ClampedContent fadeFrom="from-fill-2">
            {trimmedRecipient ? (
              <>
                <div className="wrap-break-word">
                  <span className="text-primary-6">@{trimmedRecipient}</span>
                  {"  "}
                  {firstLine}
                </div>
                {restBody && (
                  <Markdown
                    textContent={restBody}
                    useChatCodeBlock={true}
                    enableFileNavigation={true}
                    skipPreprocess={false}
                    sessionReferencesAsCards
                  />
                )}
              </>
            ) : (
              <Markdown
                textContent={trimmedBody}
                useChatCodeBlock={true}
                enableFileNavigation={true}
                skipPreprocess={false}
                sessionReferencesAsCards
              />
            )}
          </ClampedContent>
        </ChatBubbleBody>
        {toolUseSummaryLabel && (
          <div className="mt-1 px-2 text-[13px] leading-5 text-text-3">
            {toolUseSummaryLabel}
          </div>
        )}
      </div>
    </div>
  );
};

GroupChatMessageBubble.displayName = "GroupChatMessageBubble";

export default GroupChatMessageBubble;
