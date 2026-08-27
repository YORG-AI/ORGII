/**
 * Inbox Page
 *
 * A simple two-pane view over the static notification channels
 * (Git, Work Items, Promotions). The left panel lists channels;
 * selecting one shows the classic message feed on the right.
 *
 * Agent-org chats used to share this page; they were removed when
 * agent-org chatting was deemed unnecessary as a top-level surface.
 */
import SplitViewLayout from "@/src/modules/shared/layouts/SplitViewLayout";
import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";

import { ChannelFeedPanel, ChannelListPanel } from "./components";
import { useInbox } from "./hooks/useInbox";

const Inbox: React.FC = () => {
  const { t } = useTranslation();

  const {
    activeChannelId,
    activeChannelConfig,
    dateGroups,
    unreadCounts,
    lastMessageByChannel,
    searchQuery,

    selectChannel,
    handleDeleteMessage,
    handleMarkAsRead,
    handleMarkAllAsRead,
    setSearchQuery,
  } = useInbox();

  return (
    <SplitViewLayout
      className="h-full rounded-page"
      collapsible={true}
      listWidth={200}
      minListWidth={160}
      resizable={true}
      alwaysShowBreadcrumb={true}
      listContent={
        <ChannelListPanel
          activeChannelId={activeChannelId}
          unreadCounts={unreadCounts}
          lastMessageByChannel={lastMessageByChannel}
          onChannelSelect={selectChannel}
        />
      }
      mainContent={
        activeChannelConfig ? (
          <ChannelFeedPanel
            channelConfig={activeChannelConfig}
            dateGroups={dateGroups}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onDeleteMessage={handleDeleteMessage}
            onMarkAsRead={handleMarkAsRead}
            onMarkAllAsRead={handleMarkAllAsRead}
            hasUnread={
              activeChannelId ? (unreadCounts[activeChannelId] ?? 0) > 0 : false
            }
          />
        ) : (
          <Placeholder
            variant="empty"
            placement="detail-panel"
            title={t("inbox.selectChannel")}
            subtitle={t("placeholders.selectItemToStart")}
            fillParentHeight
          />
        )
      }
    />
  );
};

export default Inbox;
