/**
 * ChannelListPanel
 *
 * Left sidebar of the Inbox. Renders the static notification
 * channels (Git, Work Items, Promotions). Selecting one shows the
 * classic message feed in the right pane via `ChannelFeedPanel`.
 */
import type { LucideIcon } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { LIST_PANEL_SECTIONS } from "@src/components/ListPanel";
import { Placeholder } from "@src/components/Placeholder";
import ConfigListItem from "@src/modules/shared/layouts/ListDetailSubpage/ConfigListItem";
import { ListPanelScrollArea } from "@src/modules/shared/layouts/blocks";

import { INBOX_CHANNELS, type InboxCategory } from "../config";

interface ChannelListPanelProps {
  activeChannelId: InboxCategory | null;
  unreadCounts: Record<string, number>;
  /** `channelId → last-message preview text` for the static channels. */
  lastMessageByChannel: Record<string, string>;
  onChannelSelect: (channelId: InboxCategory) => void;
}

const ChannelListPanel: React.FC<ChannelListPanelProps> = ({
  activeChannelId,
  unreadCounts,
  lastMessageByChannel,
  onChannelSelect,
}) => {
  const { t } = useTranslation();

  const handleChannelClick = (id: string) => {
    onChannelSelect(id as InboxCategory);
  };

  const hasChannels = INBOX_CHANNELS.length > 0;

  return (
    <div className="flex h-full flex-col">
      <ListPanelScrollArea listPaddingTop="default">
        {!hasChannels ? (
          <Placeholder variant="empty" title={t("inbox.noMessages")} />
        ) : (
          <div className={LIST_PANEL_SECTIONS.container}>
            <div className={LIST_PANEL_SECTIONS.sectionGroupItems}>
              {INBOX_CHANNELS.map((channel) => (
                <ConfigListItem
                  key={channel.id}
                  id={channel.id}
                  label={t(channel.labelKey)}
                  subtitle={lastMessageByChannel[channel.id] || undefined}
                  isSelected={activeChannelId === channel.id}
                  onClick={handleChannelClick}
                  iconElement={
                    <ChannelIcon icon={channel.icon} color={channel.color} />
                  }
                  trailing={
                    <UnreadBadge count={unreadCounts[channel.id] ?? 0} />
                  }
                />
              ))}
            </div>
          </div>
        )}
      </ListPanelScrollArea>
    </div>
  );
};

interface ChannelIconProps {
  icon: LucideIcon;
  color: string;
}

const ChannelIcon: React.FC<ChannelIconProps> = ({ icon: Icon, color }) => (
  <div
    className="flex h-6 w-6 items-center justify-center rounded-md"
    style={{ backgroundColor: `${color}15` }}
  >
    <Icon size={14} style={{ color }} />
  </div>
);

const UnreadBadge: React.FC<{ count: number }> = ({ count }) => {
  if (count === 0) return null;
  return (
    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-6 px-1.5 text-[10px] font-semibold text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
};

export default ChannelListPanel;
