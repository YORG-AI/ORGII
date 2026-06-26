import type { TFunction } from "i18next";
import React from "react";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import { SectionContainer } from "@src/modules/shared/layouts/SectionLayout";
import { COLLAB_IDENTITY_KIND } from "@src/store/collaboration/types";
import type {
  CollabChatMessageRecord,
  CollabMemberRecord,
} from "@src/store/collaboration/types";

import { formatSessionDate } from "./utils";

interface ChatSectionProps {
  t: TFunction<"navigation">;
  messages: CollabChatMessageRecord[];
  currentMember: CollabMemberRecord | undefined;
  draftMessage: string;
  sending: boolean;
  chatError: string | null;
  onDraftMessageChange: (value: string) => void;
  onSendMessage: () => void;
}

export function ChatSection({
  t,
  messages,
  currentMember,
  draftMessage,
  sending,
  chatError,
  onDraftMessageChange,
  onSendMessage,
}: ChatSectionProps) {
  return (
    <SectionContainer color="chatPanelInfo" padding="default">
      <div className="flex min-h-[320px] flex-col gap-3">
        <div className="text-[12px] text-text-3">
          {t("collaboration.chat.hint")}
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg bg-fill-1 p-3">
          {messages.length === 0 ? (
            <div className="flex h-full min-h-[160px] items-center justify-center text-[13px] text-text-3">
              {t("collaboration.chat.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {messages.map((message) => (
                <div key={message.id} className="rounded-lg bg-bg-2 px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-text-3">
                    <span className="font-medium text-text-2">
                      {message.authorDisplayName}
                    </span>
                    <span>{formatSessionDate(message.createdAt)}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-[13px] text-text-1">
                    {message.body}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {chatError ? (
          <div className="text-[12px] text-danger-6">{chatError}</div>
        ) : null}
        {currentMember?.identityKind === COLLAB_IDENTITY_KIND.AGENT ? (
          <div className="text-[12px] text-text-3">
            {t("collaboration.chat.humanOnly")}
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              value={draftMessage}
              onChange={onDraftMessageChange}
              placeholder={t("collaboration.chat.placeholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSendMessage();
                }
              }}
            />
            <Button
              htmlType="button"
              variant="primary"
              disabled={!draftMessage.trim() || sending}
              loading={sending}
              onClick={() => void onSendMessage()}
            >
              {t("collaboration.chat.send")}
            </Button>
          </div>
        )}
      </div>
    </SectionContainer>
  );
}
