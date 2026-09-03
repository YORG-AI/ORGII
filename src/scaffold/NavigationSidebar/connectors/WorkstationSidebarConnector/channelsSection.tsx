/**
 * Cloud-org "Channels" sidebar section (Slack-style org channels). Rows
 * navigate: clicking one opens (or focuses) its discussion-channel tab and
 * the row takes the ordinary selected state. The cloud message plane is
 * still gated — `0014_org_channels.sql` ships the control plane only, so
 * that surface renders read-only with a disabled composer.
 *
 * Coordinator in the `useCloudSessionsSection` shape: data comes from
 * `useOrgChannels` (capability-gated; the section hides entirely on
 * "unsupported"/"signedOut"), row/section assembly lives in the pure
 * `channelsSection.menuItems.ts` sibling, and this hook owns which dialog is
 * open for which channel. The five channel dialogs (create / settings /
 * archive / delete / members) are mounted exactly once via the returned
 * `channelsDialogs` node (rendered inside `SidebarDialogs`, the
 * `cloudMemberFilterDropdown` precedent).
 *
 * Row overflow uses the native Tauri context menu like the Team Sessions
 * rows. The Tauri `MenuItem` API has no destructive styling, so "Delete
 * channel" renders as a plain entry (the row-action model limitation noted
 * in the design spec).
 *
 * "Leave channel" opens `ManageChannelMembersDialog` — the leave affordance
 * lives there, which keeps the `ORG2_LAST_MANAGER` refusal handling in one
 * place instead of duplicating a remove-self RPC flow here.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { bumpOrg2CloudChannelsVersionAtom } from "@src/features/Org2Cloud/channels/channelsAtom";
import {
  isOrg2ChannelsErrorCode,
  unarchiveCloudChannel,
} from "@src/features/Org2Cloud/channels/channelsClient";
import ArchiveChannelDialog from "@src/features/Org2Cloud/channels/components/ArchiveChannelDialog";
import ChannelSettingsDialog from "@src/features/Org2Cloud/channels/components/ChannelSettingsDialog";
import CreateChannelDialog from "@src/features/Org2Cloud/channels/components/CreateChannelDialog";
import DeleteChannelDialog from "@src/features/Org2Cloud/channels/components/DeleteChannelDialog";
import ManageChannelMembersDialog from "@src/features/Org2Cloud/channels/components/ManageChannelMembersDialog";
import type { CloudChannel } from "@src/features/Org2Cloud/channels/types";
import { useOrgChannels } from "@src/features/Org2Cloud/channels/useOrgChannels";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { createLogger } from "@src/hooks/logger";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  activeChatPanelTabAtom,
  closeOtherThanActiveChatPanelTabsAtom,
  openChannelInChatPanelTabAtom,
  reconcileDiscussionChannelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import {
  type SidebarTabDisposition,
  completeSidebarTabNavigation,
} from "../sidebarTabNavigation";
import {
  CLOUD_CHANNELS_EMPTY_ID,
  type ChannelRowActionKind,
  buildCloudChannelRowId,
  buildCloudChannelsMenuItems,
  isChannelManager,
  isCloudChannelsMenuItemId,
  isCloudOrgAdminRole,
} from "./channelsSection.menuItems";

const log = createLogger("ChannelsSidebarSection");

/**
 * Open-dialog state, stamped with the org it was opened for: an org switch
 * makes the stamp stale, so the dialogs render closed without any
 * reset-in-effect (`react-hooks/set-state-in-effect`-safe derivation).
 */
type ChannelsDialogState = { orgId: string } & (
  | { kind: "create" }
  | { kind: "settings"; channel: CloudChannel }
  | { kind: "archive"; channel: CloudChannel }
  | { kind: "delete"; channel: CloudChannel }
  | { kind: "members"; channel: CloudChannel; canManage: boolean }
);

interface UseCloudChannelsSectionParams {
  /** Active cloud org id (bare, not `cloud:`-prefixed); null ⇒ no section. */
  orgId: string | null;
}

interface UseCloudChannelsSectionResult {
  /** Separator + channel rows; empty when hidden (no scope / unsupported). */
  channelsMenuItems: NavigationMenuItem[];
  /**
   * Click resolver for the section's rows. A channel row opens (or focuses)
   * its message surface in a chat-panel tab; the ready-and-empty "Create a
   * channel" row opens the create dialog.
   */
  handleChannelsItemClick: (
    item: NavigationMenuItem,
    disposition?: SidebarTabDisposition
  ) => boolean;
  /**
   * Row id of the channel whose surface is the active chat-panel tab, or
   * null. Overrides the session-derived selection so the open channel reads
   * as selected like any other navigable row.
   */
  selectedChannelMenuItemId: string | null;
  /** The five channel dialogs — render once next to the sidebar. */
  channelsDialogs: React.ReactNode;
}

export function useCloudChannelsSection({
  orgId,
}: UseCloudChannelsSectionParams): UseCloudChannelsSectionResult {
  const { t } = useTranslation("navigation");
  const { t: tCommon } = useTranslation("common");
  const {
    phase,
    channels,
    archivedChannels,
    getFreshAccessToken,
    currentUserId,
  } = useOrgChannels(orgId, { includeArchived: true });
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const bumpChannelsVersion = useSetAtom(bumpOrg2CloudChannelsVersionAtom);
  const activeChatPanelTab = useAtomValue(activeChatPanelTabAtom);
  const openChannelTab = useSetAtom(openChannelInChatPanelTabAtom);
  const closeOtherThanActiveTabs = useSetAtom(
    closeOtherThanActiveChatPanelTabsAtom
  );
  const reconcileChannelTabs = useSetAtom(reconcileDiscussionChannelTabsAtom);
  const accessibleChannels = useMemo(
    () => [...channels, ...archivedChannels],
    [archivedChannels, channels]
  );

  // `includeArchived: true` makes this an authoritative access listing:
  // absence means revoked or hard-deleted, never merely archived.
  useEffect(() => {
    if (phase !== "ready" || !orgId) return;
    reconcileChannelTabs({
      scope: "cloud",
      orgId,
      channels: accessibleChannels.map((channel) => ({
        scope: "cloud",
        orgId,
        channelId: channel.id,
        name: channel.name,
        visibility: channel.visibility,
      })),
    });
  }, [accessibleChannels, orgId, phase, reconcileChannelTabs]);

  // Archived rows navigate too: archiving hides a channel from the active
  // list, it does not make its history unreadable.
  const channelsByRowId = useMemo(() => {
    const map = new Map<string, CloudChannel>();
    if (!orgId) return map;
    for (const channel of accessibleChannels) {
      map.set(buildCloudChannelRowId(orgId, channel.id), channel);
    }
    return map;
  }, [accessibleChannels, orgId]);

  const isOrgAdmin = useMemo(() => {
    const activeOrg = orgId
      ? cloudOrgs.find((org) => org.orgId === orgId)
      : undefined;
    return isCloudOrgAdminRole(activeOrg?.role);
  }, [cloudOrgs, orgId]);

  const [dialogState, setDialogState] = useState<ChannelsDialogState | null>(
    null
  );
  const accessibleChannelIds = useMemo(
    () => new Set(accessibleChannels.map((channel) => channel.id)),
    [accessibleChannels]
  );
  // An org switch, revocation, or hard delete invalidates a channel-bound
  // dialog target. Derive closed instead of resetting state in an effect.
  const activeDialog =
    dialogState &&
    dialogState.orgId === orgId &&
    (dialogState.kind === "create" ||
      accessibleChannelIds.has(dialogState.channel.id))
      ? dialogState
      : null;

  // Deriving closed hides the dialog but must not PARK it: with the stale
  // state retained, switching back to this org hours later would silently
  // reopen a possibly-destructive dialog. Drop the state once it derives
  // closed (microtask keeps the render pure for the lint contract).
  useEffect(() => {
    if (dialogState && activeDialog === null) {
      queueMicrotask(() => {
        setDialogState((current) => (current === dialogState ? null : current));
      });
    }
  }, [activeDialog, dialogState]);

  const closeDialog = useCallback(() => setDialogState(null), []);

  const openCreateDialog = useCallback(() => {
    if (orgId) setDialogState({ orgId, kind: "create" });
  }, [orgId]);

  const openMembersDialog = useCallback(
    (channel: CloudChannel) => {
      if (!orgId) return;
      setDialogState({
        orgId,
        kind: "members",
        channel,
        canManage: isChannelManager(channel) || isOrgAdmin,
      });
    },
    [isOrgAdmin, orgId]
  );

  const openChannelActionsMenu = useCallback(
    (channel: CloudChannel, kinds: readonly ChannelRowActionKind[]) => {
      if (!orgId) return;
      const entries: Record<
        ChannelRowActionKind,
        { text: string; action: () => void }
      > = {
        manageMembers: {
          text: t("cloud.channels.manageMembers"),
          action: () => openMembersDialog(channel),
        },
        archive: {
          text: t("cloud.channels.archiveAction"),
          action: () => setDialogState({ orgId, kind: "archive", channel }),
        },
        delete: {
          text: t("cloud.channels.deleteAction"),
          action: () => setDialogState({ orgId, kind: "delete", channel }),
        },
        // The members dialog carries the leave affordance; opening it beats
        // duplicating the remove-self flow (and its last-manager refusal).
        leave: {
          text: t("cloud.channels.leave"),
          action: () => openMembersDialog(channel),
        },
      };
      // "Channel settings" (rename/topic/post-policy) is gated to channel
      // managers / org admins — the server re-checks either way. Prepended
      // here rather than joining `ChannelRowActionKind` so the pure kind
      // builders (and their test contract) stay untouched.
      const settingsEntries =
        isChannelManager(channel) || isOrgAdmin
          ? [
              {
                text: t("cloud.channels.settings.action"),
                action: () =>
                  setDialogState({ orgId, kind: "settings", channel }),
              },
            ]
          : [];
      void popupNativeMenu({
        source: "cloud-channel-row",
        buildItems: () => [
          ...settingsEntries,
          ...kinds.map((kind) => entries[kind]),
        ],
      }).catch((error) => {
        log.warn("channel row menu failed to open:", error);
      });
    },
    [isOrgAdmin, openMembersDialog, orgId, t]
  );

  const handleUnarchive = useCallback(
    (channel: CloudChannel) => {
      if (!orgId) return;
      void (async () => {
        try {
          const accessToken = await getFreshAccessToken();
          await unarchiveCloudChannel(accessToken, orgId, channel.id);
          bumpChannelsVersion(orgId);
        } catch (error) {
          log.warn("unarchive channel failed:", error);
          // Unarchive re-enters the active quota server-side; mirror the
          // local section's dedicated quota message.
          Message.error(
            isOrg2ChannelsErrorCode(error, "ORG2_QUOTA_EXCEEDED")
              ? t("cloud.channels.create.quotaExceeded")
              : t("cloud.channels.unarchiveFailed")
          );
        }
      })();
    },
    [bumpChannelsVersion, getFreshAccessToken, orgId, t]
  );

  const handleDeleteFromArchived = useCallback(
    (channel: CloudChannel) => {
      if (orgId) setDialogState({ orgId, kind: "delete", channel });
    },
    [orgId]
  );

  const channelsMenuItems = useMemo(
    () =>
      buildCloudChannelsMenuItems({
        orgId,
        phase,
        channels,
        archivedChannels,
        isOrgAdmin,
        t,
        tCommon,
        onCreateClick: openCreateDialog,
        onOpenChannelMenu: openChannelActionsMenu,
        onUnarchive: handleUnarchive,
        onDeleteChannel: handleDeleteFromArchived,
      }),
    [
      orgId,
      phase,
      channels,
      archivedChannels,
      isOrgAdmin,
      t,
      tCommon,
      openCreateDialog,
      openChannelActionsMenu,
      handleUnarchive,
      handleDeleteFromArchived,
    ]
  );

  const handleChannelsItemClick = useCallback(
    (
      item: NavigationMenuItem,
      disposition: SidebarTabDisposition = "replace-all"
    ): boolean => {
      if (!isCloudChannelsMenuItemId(item.id)) return false;
      if (item.id === CLOUD_CHANNELS_EMPTY_ID) {
        // Only the ready-and-empty variant is clickable (loading/error rows
        // are disabled and never reach this resolver).
        openCreateDialog();
        return true;
      }
      const channel = channelsByRowId.get(item.id);
      if (channel && orgId) {
        openChannelTab({
          scope: "cloud",
          orgId,
          channelId: channel.id,
          name: channel.name,
          visibility: channel.visibility,
        });
        completeSidebarTabNavigation(disposition, closeOtherThanActiveTabs);
      }
      // Handled either way: the separator and the "Archived" group header
      // carry no navigation, and the sidebar must not fall through to the
      // team-sessions resolver for ids in this section's namespace.
      return true;
    },
    [
      channelsByRowId,
      closeOtherThanActiveTabs,
      openChannelTab,
      openCreateDialog,
      orgId,
    ]
  );

  const selectedChannelMenuItemId =
    orgId &&
    activeChatPanelTab?.type === "channel" &&
    activeChatPanelTab.channel?.scope === "cloud" &&
    activeChatPanelTab.channel.orgId === orgId
      ? buildCloudChannelRowId(orgId, activeChatPanelTab.channel.channelId)
      : null;

  const channelsDialogs = (
    <>
      {/* Keyed per org: the dialog keeps its draft across close/reopen, but
          an org switch must drop it — a private-member selection made from
          org A's roster is invisible in org B's picker and the server
          rejects it (ORG2_VALIDATION) on every submit. */}
      <CreateChannelDialog
        key={`create-${orgId ?? "none"}`}
        open={activeDialog?.kind === "create"}
        orgId={orgId}
        onClose={closeDialog}
      />
      {/* Keyed per open + target: each open is a fresh mount, seeding the
          form from the channel without any reset-in-effect. */}
      <ChannelSettingsDialog
        key={
          activeDialog?.kind === "settings"
            ? `settings-${activeDialog.channel.id}`
            : "settings"
        }
        open={activeDialog?.kind === "settings"}
        orgId={orgId}
        channel={
          activeDialog?.kind === "settings" ? activeDialog.channel : null
        }
        onClose={closeDialog}
      />
      <ArchiveChannelDialog
        open={activeDialog?.kind === "archive"}
        orgId={orgId}
        channel={activeDialog?.kind === "archive" ? activeDialog.channel : null}
        onClose={closeDialog}
      />
      <DeleteChannelDialog
        open={activeDialog?.kind === "delete"}
        orgId={orgId}
        channel={activeDialog?.kind === "delete" ? activeDialog.channel : null}
        onClose={closeDialog}
      />
      <ManageChannelMembersDialog
        open={activeDialog?.kind === "members"}
        orgId={orgId}
        channel={activeDialog?.kind === "members" ? activeDialog.channel : null}
        currentUserId={currentUserId}
        canManage={activeDialog?.kind === "members" && activeDialog.canManage}
        onClose={closeDialog}
      />
    </>
  );

  return {
    channelsMenuItems,
    handleChannelsItemClick,
    selectedChannelMenuItemId,
    channelsDialogs,
  };
}
