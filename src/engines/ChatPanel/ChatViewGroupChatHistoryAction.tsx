/**
 * ChatViewGroupChatHistoryAction — trailing pagination-bar action for group
 * chat: a retry button when the merged history failed to load, or a
 * "load older" button when there's more history above the current page.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";

interface ChatViewGroupChatHistoryActionProps {
  groupChatViewActive: boolean;
  groupChatHistoryError: string | null;
  groupChatHistoryHasMore: boolean;
  groupChatHistoryLoading: boolean;
  onRetry: () => void;
  onLoadOlder: () => void;
}

export function ChatViewGroupChatHistoryAction({
  groupChatViewActive,
  groupChatHistoryError,
  groupChatHistoryHasMore,
  groupChatHistoryLoading,
  onRetry,
  onLoadOlder,
}: ChatViewGroupChatHistoryActionProps) {
  const { t } = useTranslation("sessions");

  if (!groupChatViewActive) return null;

  if (groupChatHistoryError) {
    return (
      <Button
        variant="tertiary"
        appearance="ghost"
        size="small"
        onClick={onRetry}
        title={`${t("sessions:groupChat.historyLoadFailed", {
          defaultValue: "History unavailable",
        })}: ${groupChatHistoryError}`}
      >
        {t("common:retry", {
          defaultValue: "Retry",
        })}
      </Button>
    );
  }

  if (groupChatHistoryHasMore) {
    return (
      <Button
        variant="tertiary"
        appearance="ghost"
        size="small"
        loading={groupChatHistoryLoading}
        onClick={onLoadOlder}
        title={t("sessions:groupChat.loadOlder", {
          defaultValue: "Load older messages",
        })}
      >
        {t("sessions:groupChat.loadOlder", {
          defaultValue: "Load older messages",
        })}
      </Button>
    );
  }

  return null;
}
