/**
 * Pure assembly for the LOCAL-scope "Channels" sidebar section
 * (`localChannelsSection.tsx`) — the single-user, this-machine counterpart
 * of `channelsSection.menuItems.ts`. Shares its scope-neutral builder pieces
 * (header + `+` create action, channel rows, ready-and-empty funnel row,
 * collapsed "Archived" subgroup); what stays local-specific: rows are always
 * `Hash` (no private visibility), and there is no role gating — every row
 * offers settings / archive / delete (this machine's user owns everything).
 *
 * Channel rows navigate: the section's click resolver opens (or focuses) the
 * row's message surface in a chat-panel tab, and the row takes the ordinary
 * selected state while that tab is active.
 */
import type { TFunction } from "i18next";
import type { MouseEvent } from "react";

import {
  ArchiveArrowUpIcon,
  Delete02Icon,
  HashtagIcon,
  MoreHorizontalIcon,
} from "@src/icons";
import type {
  NavigationMenuItem,
  NavigationMenuRowAction,
} from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { LocalChannel } from "@src/store/ui/localChannelsAtom";

import {
  buildArchivedChannelsGroup,
  buildChannelMenuRow,
  buildChannelsSectionHeader,
  buildCreateFirstChannelRow,
} from "./channelsSection.menuItems";

export const LOCAL_CHANNELS_SECTION_ID = "local-channels";
/** Ready-and-empty "Create a channel" funnel row. */
export const LOCAL_CHANNELS_EMPTY_ID = "local-channels-empty";
export const LOCAL_CHANNELS_ARCHIVED_GROUP_ID = "local-channels-archived";
const LOCAL_CHANNEL_ROW_ID_PREFIX = "local-channel-";

export function buildLocalChannelRowId(channelId: string): string {
  return `${LOCAL_CHANNEL_ROW_ID_PREFIX}${channelId}`;
}

/** True for every menu item the local section can emit (header included). */
export function isLocalChannelsMenuItemId(id: string): boolean {
  return (
    id === LOCAL_CHANNELS_EMPTY_ID ||
    id === LOCAL_CHANNELS_ARCHIVED_GROUP_ID ||
    id === `separator-${LOCAL_CHANNELS_SECTION_ID}` ||
    id.startsWith(LOCAL_CHANNEL_ROW_ID_PREFIX)
  );
}

/**
 * Overflow-menu entries for an active local row, in render order. No gating:
 * local channels are single-user, so settings/archive/delete are always
 * offered (the cloud `build*ActionKinds` role logic has no analog here).
 */
export const LOCAL_CHANNEL_ROW_ACTION_KINDS = [
  "settings",
  "archive",
  "delete",
] as const;

export type LocalChannelRowActionKind =
  (typeof LOCAL_CHANNEL_ROW_ACTION_KINDS)[number];

export interface BuildLocalChannelsMenuItemsParams {
  /** False while a cloud org scope is active — the section hides entirely. */
  enabled: boolean;
  channels: readonly LocalChannel[];
  archivedChannels: readonly LocalChannel[];
  t: TFunction;
  tCommon: TFunction;
  onCreateClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Opens the row's overflow (native context) menu. */
  onOpenChannelMenu: (channel: LocalChannel) => void;
  onUnarchive: (channel: LocalChannel) => void;
  onDeleteChannel: (channel: LocalChannel) => void;
}

export function buildLocalChannelsMenuItems({
  enabled,
  channels,
  archivedChannels,
  t,
  tCommon,
  onCreateClick,
  onOpenChannelMenu,
  onUnarchive,
  onDeleteChannel,
}: BuildLocalChannelsMenuItemsParams): NavigationMenuItem[] {
  if (!enabled) return [];

  const items: NavigationMenuItem[] = [
    buildChannelsSectionHeader({
      sectionId: LOCAL_CHANNELS_SECTION_ID,
      title: t("cloud.channels.title"),
      createLabel: t("cloud.channels.createAction"),
      createTestId: "local-channels-create",
      onCreateClick,
    }),
  ];

  for (const channel of channels) {
    items.push(
      buildChannelMenuRow({
        id: buildLocalChannelRowId(channel.id),
        name: channel.name,
        topic: channel.topic,
        icon: HashtagIcon,
        dataTestId: `sidebar-local-channel-${channel.id}`,
        rowActions: [
          {
            icon: MoreHorizontalIcon,
            label: tCommon("actions.more"),
            dataTestId: `local-channel-more-${channel.id}`,
            onClick: () => onOpenChannelMenu(channel),
          },
        ],
      })
    );
  }

  if (channels.length === 0) {
    // Local storage is synchronous, so the section is always "ready": the
    // only funnel state is ready-and-empty (clickable create row).
    items.push(
      buildCreateFirstChannelRow({
        id: LOCAL_CHANNELS_EMPTY_ID,
        label: t("cloud.channels.createFirst"),
        dataTestId: "local-channels-empty",
      })
    );
  }

  if (archivedChannels.length > 0) {
    items.push(
      buildArchivedChannelsGroup({
        id: LOCAL_CHANNELS_ARCHIVED_GROUP_ID,
        label: t("cloud.channels.archivedGroup"),
        dataTestId: "local-channels-archived-group",
        children: archivedChannels.map((channel) => {
          const rowActions: NavigationMenuRowAction[] = [
            {
              icon: ArchiveArrowUpIcon,
              label: t("cloud.channels.unarchive"),
              dataTestId: `local-channel-unarchive-${channel.id}`,
              onClick: () => onUnarchive(channel),
            },
            {
              icon: Delete02Icon,
              label: t("cloud.channels.deleteAction"),
              dataTestId: `local-channel-delete-${channel.id}`,
              onClick: () => onDeleteChannel(channel),
            },
          ];
          return buildChannelMenuRow({
            id: buildLocalChannelRowId(channel.id),
            name: channel.name,
            topic: channel.topic,
            icon: HashtagIcon,
            dataTestId: `sidebar-local-channel-${channel.id}`,
            rowActions,
          });
        }),
      })
    );
  }

  return items;
}
