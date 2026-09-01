/**
 * Local-scope "Channels" sidebar section — the this-machine counterpart of
 * the cloud `channelsSection.tsx`. Rendered only while NO cloud org scope is
 * active (`enabled`); data comes straight from the persisted
 * `localChannelsAtom` (synchronous, so there are no loading/error phases),
 * row/section assembly lives in the pure `localChannelsSection.menuItems.ts`
 * sibling, and this hook owns which dialog is open for which channel. The
 * four local dialogs are mounted exactly once via the returned
 * `localChannelsDialogs` node (rendered inside `SidebarDialogs`, the
 * `cloudChannelsDialogs` precedent).
 *
 * Row overflow uses the native Tauri context menu like the cloud section
 * (same `MenuItem` API limitation: no destructive styling for "Delete
 * channel"). No role gating — a local channel's single user can always open
 * settings, archive, and delete.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import ArchiveLocalChannelDialog from "@src/features/LocalChannels/components/ArchiveLocalChannelDialog";
import CreateLocalChannelDialog from "@src/features/LocalChannels/components/CreateLocalChannelDialog";
import DeleteLocalChannelDialog from "@src/features/LocalChannels/components/DeleteLocalChannelDialog";
import LocalChannelSettingsDialog from "@src/features/LocalChannels/components/LocalChannelSettingsDialog";
import { createLogger } from "@src/hooks/logger";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  activeChatPanelTabAtom,
  openChannelInChatPanelTabAtom,
  reconcileDiscussionChannelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  type LocalChannel,
  activeLocalChannelsAtom,
  archivedLocalChannelsAtom,
  isLocalChannelRegistryHydrationDegraded,
  reconcileLocalChannelMessagesAtom,
  unarchiveLocalChannelAtom,
} from "@src/store/ui/localChannelsAtom";
import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import {
  LOCAL_CHANNELS_EMPTY_ID,
  buildLocalChannelRowId,
  buildLocalChannelsMenuItems,
  isLocalChannelsMenuItemId,
} from "./localChannelsSection.menuItems";

const log = createLogger("LocalChannelsSection");

type LocalChannelsDialogState =
  | { kind: "create" }
  | { kind: "settings"; channel: LocalChannel }
  | { kind: "archive"; channel: LocalChannel }
  | { kind: "delete"; channel: LocalChannel };

interface UseLocalChannelsSectionParams {
  /** True only while the sidebar is in the local (no cloud org) scope. */
  enabled: boolean;
}

interface UseLocalChannelsSectionResult {
  /** Separator + channel rows; empty while a cloud org scope is active. */
  localChannelsMenuItems: NavigationMenuItem[];
  /**
   * Click resolver for the section's rows. A channel row opens (or focuses)
   * its message surface in a chat-panel tab; the ready-and-empty "Create a
   * channel" row opens the create dialog.
   */
  handleLocalChannelsItemClick: (item: NavigationMenuItem) => boolean;
  /**
   * Row id of the channel whose surface is the active chat-panel tab, or
   * null. Overrides the session-derived selection so the open channel reads
   * as selected like any other navigable row.
   */
  selectedLocalChannelMenuItemId: string | null;
  /** The four local channel dialogs — render once next to the sidebar. */
  localChannelsDialogs: React.ReactNode;
}

export function useLocalChannelsSection({
  enabled,
}: UseLocalChannelsSectionParams): UseLocalChannelsSectionResult {
  const { t } = useTranslation("navigation");
  const { t: tCommon } = useTranslation("common");
  const channels = useAtomValue(activeLocalChannelsAtom);
  const archivedChannels = useAtomValue(archivedLocalChannelsAtom);
  const unarchiveChannel = useSetAtom(unarchiveLocalChannelAtom);
  const reconcileMessages = useSetAtom(reconcileLocalChannelMessagesAtom);
  const activeChatPanelTab = useAtomValue(activeChatPanelTabAtom);
  const openChannelTab = useSetAtom(openChannelInChatPanelTabAtom);
  const reconcileChannelTabs = useSetAtom(reconcileDiscussionChannelTabsAtom);
  const accessibleChannels = useMemo(
    () => [...channels, ...archivedChannels],
    [archivedChannels, channels]
  );

  // App-start reconciliation closes the old crash/interrupted-delete gap:
  // persisted message rows without a control-plane owner are swept once.
  useEffect(() => {
    const result = reconcileMessages();
    if (result.removed > 0) {
      log.info(
        `purged ${result.removed} orphaned local channel messages across ${result.orphanedChannelIds.length} channels`
      );
    }
  }, [reconcileMessages]);

  useEffect(() => {
    // A degraded registry read hydrates to [] — that empty set is data loss,
    // not an authoritative "no channels", so it must not close every tab.
    if (isLocalChannelRegistryHydrationDegraded()) return;
    reconcileChannelTabs({
      scope: "local",
      channels: accessibleChannels.map((channel) => ({
        scope: "local",
        channelId: channel.id,
        name: channel.name,
      })),
    });
  }, [accessibleChannels, reconcileChannelTabs]);

  // Archived rows navigate too: an archived channel is hidden from the
  // active list but its history stays readable.
  const channelsByRowId = useMemo(() => {
    const map = new Map<string, LocalChannel>();
    for (const channel of accessibleChannels) {
      map.set(buildLocalChannelRowId(channel.id), channel);
    }
    return map;
  }, [accessibleChannels]);

  const [dialogState, setDialogState] =
    useState<LocalChannelsDialogState | null>(null);
  const accessibleChannelIds = useMemo(
    () => new Set(accessibleChannels.map((channel) => channel.id)),
    [accessibleChannels]
  );
  // A scope switch or a delete from another local surface invalidates a
  // channel-bound dialog target. Derive closed instead of resetting in an
  // effect.
  const activeDialog =
    enabled &&
    dialogState &&
    (dialogState.kind === "create" ||
      accessibleChannelIds.has(dialogState.channel.id))
      ? dialogState
      : null;

  // Deriving closed hides the dialog but must not PARK it: retained stale
  // state would silently reopen a possibly-destructive dialog when the
  // scope flips back. Drop it once derived closed.
  useEffect(() => {
    if (dialogState && activeDialog === null) {
      queueMicrotask(() => {
        setDialogState((current) => (current === dialogState ? null : current));
      });
    }
  }, [activeDialog, dialogState]);

  const closeDialog = useCallback(() => setDialogState(null), []);
  const openCreateDialog = useCallback(
    () => setDialogState({ kind: "create" }),
    []
  );

  const openChannelActionsMenu = useCallback(
    (channel: LocalChannel) => {
      const entries = [
        {
          text: t("cloud.channels.settings.action"),
          action: () => setDialogState({ kind: "settings", channel }),
        },
        {
          text: t("cloud.channels.archiveAction"),
          action: () => setDialogState({ kind: "archive", channel }),
        },
        {
          text: t("cloud.channels.deleteAction"),
          action: () => setDialogState({ kind: "delete", channel }),
        },
      ];
      void popupNativeMenu({
        source: "local-channel-row",
        buildItems: () => entries,
      }).catch((error) => {
        log.warn("local channel row menu failed to open:", error);
      });
    },
    [t]
  );

  const handleUnarchive = useCallback(
    (channel: LocalChannel) => {
      const result = unarchiveChannel(channel.id);
      if (!result.ok) {
        Message.error(
          result.error === "quota"
            ? t("cloud.channels.local.quotaExceeded")
            : t("cloud.channels.unarchiveFailed")
        );
      }
    },
    [t, unarchiveChannel]
  );

  const handleDeleteFromArchived = useCallback((channel: LocalChannel) => {
    setDialogState({ kind: "delete", channel });
  }, []);

  const localChannelsMenuItems = useMemo(
    () =>
      buildLocalChannelsMenuItems({
        enabled,
        channels,
        archivedChannels,
        t,
        tCommon,
        onCreateClick: openCreateDialog,
        onOpenChannelMenu: openChannelActionsMenu,
        onUnarchive: handleUnarchive,
        onDeleteChannel: handleDeleteFromArchived,
      }),
    [
      enabled,
      channels,
      archivedChannels,
      t,
      tCommon,
      openCreateDialog,
      openChannelActionsMenu,
      handleUnarchive,
      handleDeleteFromArchived,
    ]
  );

  const handleLocalChannelsItemClick = useCallback(
    (item: NavigationMenuItem): boolean => {
      if (!isLocalChannelsMenuItemId(item.id)) return false;
      if (item.id === LOCAL_CHANNELS_EMPTY_ID) {
        openCreateDialog();
        return true;
      }
      const channel = channelsByRowId.get(item.id);
      if (channel) {
        openChannelTab({
          scope: "local",
          channelId: channel.id,
          name: channel.name,
        });
      }
      // Handled either way: the separator and the "Archived" group header
      // carry no navigation, and the sidebar must not fall through to the
      // session resolver for ids in this section's namespace.
      return true;
    },
    [channelsByRowId, openChannelTab, openCreateDialog]
  );

  const selectedLocalChannelMenuItemId =
    enabled &&
    activeChatPanelTab?.type === "channel" &&
    activeChatPanelTab.channel?.scope === "local"
      ? buildLocalChannelRowId(activeChatPanelTab.channel.channelId)
      : null;

  // The settings/archive/delete dialogs are KEYED per open + target: every
  // open is a fresh mount, which seeds/resets their form state without any
  // reset-in-effect (`react-hooks/set-state-in-effect`-safe).
  const settingsChannel =
    activeDialog?.kind === "settings" ? activeDialog.channel : null;
  const archiveChannel =
    activeDialog?.kind === "archive" ? activeDialog.channel : null;
  const deleteChannel =
    activeDialog?.kind === "delete" ? activeDialog.channel : null;
  const localChannelsDialogs = (
    <>
      <CreateLocalChannelDialog
        open={activeDialog?.kind === "create"}
        onClose={closeDialog}
      />
      <LocalChannelSettingsDialog
        key={settingsChannel ? `settings-${settingsChannel.id}` : "settings"}
        open={settingsChannel !== null}
        channel={settingsChannel}
        onClose={closeDialog}
      />
      <ArchiveLocalChannelDialog
        key={archiveChannel ? `archive-${archiveChannel.id}` : "archive"}
        open={archiveChannel !== null}
        channel={archiveChannel}
        onClose={closeDialog}
      />
      <DeleteLocalChannelDialog
        key={deleteChannel ? `delete-${deleteChannel.id}` : "delete"}
        open={deleteChannel !== null}
        channel={deleteChannel}
        onClose={closeDialog}
      />
    </>
  );

  return {
    localChannelsMenuItems,
    handleLocalChannelsItemClick,
    selectedLocalChannelMenuItemId,
    localChannelsDialogs,
  };
}
