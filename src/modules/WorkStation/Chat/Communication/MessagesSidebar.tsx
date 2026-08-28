/**
 * MessagesSidebar Component
 *
 * Left sidebar for the Communication app in Agent Station.
 * Uses PrimarySidebarLayout (same as Code Editor, Browser, etc.) with a single
 * pill containing Messages / Interactions sections.
 */
import React, { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { BubbleChatIcon, HugeiconsIcon } from "@src/icons";
import {
  type PanelSection,
  PrimarySidebarLayout,
} from "@src/modules/WorkStation/shared/PrimarySidebarLayout";

import {
  AggregateInteractionsRow,
  AggregateMessagesRow,
  AggregateTodoRow,
} from "./MessagesSidebarRows";
import type { MessageEntry, MessageViewMode } from "./types";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface MessagesSidebarProps {
  viewMode: MessageViewMode;
  onViewModeChange: (mode: MessageViewMode) => void;
  chatMessages?: MessageEntry[];
  todoMessages?: MessageEntry[];
  interactionMessages?: MessageEntry[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export const MessagesSidebar: React.FC<MessagesSidebarProps> = memo(
  ({
    viewMode,
    onViewModeChange,
    chatMessages = [],
    todoMessages = [],
    interactionMessages = [],
  }) => {
    const { t } = useTranslation("sessions");
    const [activeTab, setActiveTab] = useState("chatHistory");

    // ── Section content builders ──────────────────────────────────────────

    // Messages, Todos, and Interactions all share the same aggregate-row
    // pattern: one row → one filtered view. The right pane's viewMode is
    // the filter; the sidebar is just the picker. We never fan out to
    // per-event rows here (would re-introduce the N-tabs / N-rows problem
    // the consolidation is trying to remove).
    const messagesContent = useMemo(() => {
      return (
        <div className="flex flex-col">
          <AggregateMessagesRow
            title={t("simulator.replay.channelsSidebar.messages")}
            count={chatMessages.length}
            isSelected={viewMode === "chat"}
            onSelect={() => {
              if (viewMode !== "chat") {
                onViewModeChange("chat");
              }
            }}
          />
          <AggregateTodoRow
            title={t("simulator.replay.channelsSidebar.kanban")}
            count={todoMessages.length}
            isSelected={viewMode === "todo"}
            onSelect={() => {
              if (viewMode !== "todo") {
                onViewModeChange("todo");
              }
            }}
          />
          <AggregateInteractionsRow
            title={t("simulator.replay.channelsSidebar.interactions")}
            count={interactionMessages.length}
            isSelected={viewMode === "interaction"}
            onSelect={() => {
              if (viewMode !== "interaction") {
                onViewModeChange("interaction");
              }
            }}
          />
        </div>
      );
    }, [
      chatMessages.length,
      todoMessages.length,
      interactionMessages.length,
      onViewModeChange,
      t,
      viewMode,
    ]);

    // ── Tab configuration ─────────────────────────────────────────────────

    // chatMessages here is already the merged transcript (chat + todo +
    // interaction) — its length is the canonical Messages-section total.
    // Summing the three buckets would double-count todos and interactions
    // because they live in both the transcript and their dedicated lists.
    const chatHistorySections: PanelSection[] = useMemo(
      () => [
        {
          key: "messages",
          title: `${t("simulator.replay.channelsSidebar.messages")} (${chatMessages.length})`,
          content: messagesContent,
          defaultFlexGrow: 2,
          resizable: true,
        },
      ],
      [chatMessages.length, messagesContent, t]
    );

    const tabs = useMemo(
      () => [
        {
          key: "chatHistory",
          label: t("simulator.replay.channelsSidebar.chatHistoryTab"),
          icon: (
            <HugeiconsIcon
              icon={BubbleChatIcon}
              data-icon="message-circle"
              size={16}
              strokeWidth={1.75}
            />
          ),
          sections: chatHistorySections,
        },
      ],
      [chatHistorySections, t]
    );

    return (
      <PrimarySidebarLayout
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hideTabs
      />
    );
  }
);

MessagesSidebar.displayName = "MessagesSidebar";

export default MessagesSidebar;
