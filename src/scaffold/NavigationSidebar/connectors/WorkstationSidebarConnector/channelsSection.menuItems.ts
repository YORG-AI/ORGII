/**
 * Pure assembly for the cloud-org "Channels" sidebar section
 * (`channelsSection.tsx`): the separator header with its `+` create action,
 * one row per non-archived channel (`#` for org-visible, lock for private),
 * the collapsed "Archived" subgroup, and the empty/loading/error placeholder
 * row. Role gating (org admin vs channel manager vs plain member) lives in
 * the exported `build*ActionKinds` helpers so tests can cover it without
 * rendering; the hook maps kinds onto dialogs / RPCs.
 *
 * Channel rows navigate: the section's click resolver opens (or focuses) the
 * row's discussion-channel tab, and the row takes the ordinary selected state
 * while that tab is active.
 */
import type { TFunction } from "i18next";
import type { MouseEvent } from "react";

import type { CloudChannel } from "@src/features/Org2Cloud/channels/types";
import type { OrgChannelsPhase } from "@src/features/Org2Cloud/channels/useOrgChannels";
import {
  Add01Icon,
  ArchiveArrowUpIcon,
  ArchiveIcon,
  Delete02Icon,
  HashtagIcon,
  type IconSvgElement,
  LockIcon,
  MoreHorizontalIcon,
} from "@src/icons";
import type {
  NavigationMenuItem,
  NavigationMenuRowAction,
} from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { separator } from "../useSessionMenuItems/menuItemBuilders";

const CLOUD_CHANNELS_SECTION_ID = "cloud-channels";
/** Empty/loading/error funnel row; clickable "Create a channel" when ready. */
export const CLOUD_CHANNELS_EMPTY_ID = "cloud-channels-empty";
export const CLOUD_CHANNELS_ARCHIVED_GROUP_ID = "cloud-channels-archived";
const CLOUD_CHANNEL_ROW_ID_PREFIX = "cloud-channel-";

export function buildCloudChannelRowId(
  orgId: string,
  channelId: string
): string {
  return `${CLOUD_CHANNEL_ROW_ID_PREFIX}${orgId}|${channelId}`;
}

/** True for every menu item the Channels section can emit (header included). */
export function isCloudChannelsMenuItemId(id: string): boolean {
  return (
    id === CLOUD_CHANNELS_EMPTY_ID ||
    id === CLOUD_CHANNELS_ARCHIVED_GROUP_ID ||
    id === `separator-${CLOUD_CHANNELS_SECTION_ID}` ||
    id.startsWith(CLOUD_CHANNEL_ROW_ID_PREFIX)
  );
}

/** Org-level admin gate (`useProjectOrgCloudPermissions` precedent). */
export function isCloudOrgAdminRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function isChannelManager(channel: CloudChannel): boolean {
  return channel.myRole === "manager";
}

/**
 * Section visibility: render while the channel list is usable or on its way
 * ("ready" / "loading" / "error"); hide entirely on "unsupported" (old
 * backend without the `orgChannels` capability) and "signedOut".
 */
export function shouldRenderChannelsSection(phase: OrgChannelsPhase): boolean {
  return phase === "ready" || phase === "loading" || phase === "error";
}

// ---------------------------------------------------------------------------
// Scope-neutral builder pieces (shared with the LOCAL channels section —
// `localChannelsSection.menuItems.ts`). Additive: the cloud assembly below
// delegates to these without changing its emitted items.
// ---------------------------------------------------------------------------

interface ChannelsSectionHeaderParams {
  sectionId: string;
  title: string;
  createLabel: string;
  createTestId: string;
  onCreateClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Cloud sections pass `phase === "ready"`: offering create while the
   * capability probe is unresolved (or the list failed) funnels the user
   * into a submit that can only 404 on a pre-0014 backend.
   */
  showCreateAction?: boolean;
}

/** Separator header carrying the hover `+` create action. */
export function buildChannelsSectionHeader({
  sectionId,
  title,
  createLabel,
  createTestId,
  onCreateClick,
  showCreateAction = true,
}: ChannelsSectionHeaderParams): NavigationMenuItem {
  const header = separator(sectionId, title);
  if (showCreateAction) {
    header.rowActions = [
      {
        icon: Add01Icon,
        label: createLabel,
        dataTestId: createTestId,
        onClick: onCreateClick,
      },
    ];
  }
  return header;
}

interface ChannelMenuRowParams {
  id: string;
  name: string;
  /** Joins `searchText` so sidebar search matches on the topic too. */
  topic?: string;
  icon: IconSvgElement;
  dataTestId: string;
  rowActions?: NavigationMenuRowAction[];
}

/** One non-navigating channel row (rows never take a selected state). */
export function buildChannelMenuRow({
  id,
  name,
  topic,
  icon,
  dataTestId,
  rowActions,
}: ChannelMenuRowParams): NavigationMenuItem {
  const item: NavigationMenuItem = {
    id,
    key: id,
    label: name,
    searchText: topic ? `${name} ${topic}` : undefined,
    icon,
    dataTestId,
    opensChatPanelTab: true,
  };
  if (rowActions && rowActions.length > 0) {
    item.showMoreActions = true;
    item.rowActions = rowActions;
  }
  return item;
}

/** Ready-and-empty "Create a channel" funnel row (clickable, muted). */
export function buildCreateFirstChannelRow({
  id,
  label,
  dataTestId,
}: {
  id: string;
  label: string;
  dataTestId: string;
}): NavigationMenuItem {
  return {
    id,
    key: id,
    label,
    icon: Add01Icon,
    dataTestId,
    visualTone: "secondary",
  };
}

/**
 * Collapsed "Archived" subgroup header (no `navigableParent`: body click
 * toggles, and the NavigationMenu primitive keeps it collapsed by default).
 */
export function buildArchivedChannelsGroup({
  id,
  label,
  dataTestId,
  children,
}: {
  id: string;
  label: string;
  dataTestId: string;
  children: NavigationMenuItem[];
}): NavigationMenuItem {
  return { id, key: id, label, icon: ArchiveIcon, dataTestId, children };
}

export type ChannelRowActionKind =
  | "manageMembers"
  | "archive"
  | "delete"
  | "leave";

type ArchivedChannelRowActionKind = "unarchive" | "delete";

/**
 * Overflow-menu entries for a non-archived channel row, in render order.
 * "manageMembers" is unconditional (the dialog itself is read-only for
 * non-managers); "leave" needs actual membership of a private channel —
 * org-visible channels have no leave semantics in this slice.
 */
export function buildChannelActionKinds(
  channel: CloudChannel,
  isOrgAdmin: boolean
): ChannelRowActionKind[] {
  const kinds: ChannelRowActionKind[] = ["manageMembers"];
  if (isChannelManager(channel) || isOrgAdmin) kinds.push("archive");
  if (isOrgAdmin) kinds.push("delete");
  if (channel.visibility === "private" && channel.myRole !== null) {
    kinds.push("leave");
  }
  return kinds;
}

/** Hover actions for an archived channel row, in render order. */
export function buildArchivedChannelActionKinds(
  channel: CloudChannel,
  isOrgAdmin: boolean
): ArchivedChannelRowActionKind[] {
  const kinds: ArchivedChannelRowActionKind[] = [];
  if (isChannelManager(channel) || isOrgAdmin) kinds.push("unarchive");
  if (isOrgAdmin) kinds.push("delete");
  return kinds;
}

export interface BuildCloudChannelsMenuItemsParams {
  orgId: string | null;
  phase: OrgChannelsPhase;
  channels: readonly CloudChannel[];
  archivedChannels: readonly CloudChannel[];
  isOrgAdmin: boolean;
  t: TFunction;
  tCommon: TFunction;
  onCreateClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Opens the row's overflow (native context) menu for the given entries. */
  onOpenChannelMenu: (
    channel: CloudChannel,
    kinds: readonly ChannelRowActionKind[]
  ) => void;
  onUnarchive: (channel: CloudChannel) => void;
  onDeleteChannel: (channel: CloudChannel) => void;
}

function buildChannelRow(
  channel: CloudChannel,
  orgId: string,
  rowActions: NavigationMenuRowAction[]
): NavigationMenuItem {
  return buildChannelMenuRow({
    id: buildCloudChannelRowId(orgId, channel.id),
    name: channel.name,
    topic: channel.topic,
    icon: channel.visibility === "private" ? LockIcon : HashtagIcon,
    dataTestId: `sidebar-cloud-channel-${channel.id}`,
    rowActions,
  });
}

export function buildCloudChannelsMenuItems({
  orgId,
  phase,
  channels,
  archivedChannels,
  isOrgAdmin,
  t,
  tCommon,
  onCreateClick,
  onOpenChannelMenu,
  onUnarchive,
  onDeleteChannel,
}: BuildCloudChannelsMenuItemsParams): NavigationMenuItem[] {
  if (!orgId || !shouldRenderChannelsSection(phase)) return [];

  const items: NavigationMenuItem[] = [
    buildChannelsSectionHeader({
      sectionId: CLOUD_CHANNELS_SECTION_ID,
      title: t("cloud.channels.title"),
      createLabel: t("cloud.channels.createAction"),
      createTestId: "cloud-channels-create",
      onCreateClick,
      showCreateAction: phase === "ready",
    }),
  ];

  for (const channel of channels) {
    const kinds = buildChannelActionKinds(channel, isOrgAdmin);
    items.push(
      buildChannelRow(channel, orgId, [
        {
          icon: MoreHorizontalIcon,
          label: tCommon("actions.more"),
          dataTestId: `cloud-channel-more-${channel.id}`,
          onClick: () => onOpenChannelMenu(channel, kinds),
        },
      ])
    );
  }

  if (phase !== "ready") {
    // Loading/error funnel row (team-sessions pattern): the deterministic
    // proof the section rendered while it has no channel rows yet.
    items.push({
      id: CLOUD_CHANNELS_EMPTY_ID,
      key: CLOUD_CHANNELS_EMPTY_ID,
      label:
        phase === "error"
          ? t("cloud.channels.loadError")
          : t("cloud.orgPanel.loading"),
      dataTestId: "cloud-channels-empty",
      visualTone: "secondary",
      disabled: true,
    });
  } else if (channels.length === 0) {
    // Ready-and-empty: a single muted row that opens the create dialog (the
    // section click resolver routes it — see `channelsSection.tsx`).
    items.push(
      buildCreateFirstChannelRow({
        id: CLOUD_CHANNELS_EMPTY_ID,
        label: t("cloud.channels.createFirst"),
        dataTestId: "cloud-channels-empty",
      })
    );
  }

  if (archivedChannels.length > 0) {
    items.push(
      buildArchivedChannelsGroup({
        id: CLOUD_CHANNELS_ARCHIVED_GROUP_ID,
        label: t("cloud.channels.archivedGroup"),
        dataTestId: "cloud-channels-archived-group",
        children: archivedChannels.map((channel) => {
          const rowActions = buildArchivedChannelActionKinds(
            channel,
            isOrgAdmin
          ).map((kind): NavigationMenuRowAction => {
            if (kind === "unarchive") {
              return {
                icon: ArchiveArrowUpIcon,
                label: t("cloud.channels.unarchive"),
                dataTestId: `cloud-channel-unarchive-${channel.id}`,
                onClick: () => onUnarchive(channel),
              };
            }
            return {
              icon: Delete02Icon,
              label: t("cloud.channels.deleteAction"),
              dataTestId: `cloud-channel-delete-${channel.id}`,
              onClick: () => onDeleteChannel(channel),
            };
          });
          return buildChannelRow(channel, orgId, rowActions);
        }),
      })
    );
  }

  return items;
}
