import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TFunction } from "i18next";
import { useAtomValue, useStore } from "jotai";
import type { Store } from "jotai/vanilla/store";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import {
  listenForSystemNotificationActions,
  notifyTeamInbox,
  registerTeamInboxNotificationActionType,
  setDockBadge,
} from "@src/api/services/notification";
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import { openTeamInboxInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabOpenAtoms";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";

import { getTeamInboxItemKey } from "./domain";
import type { TeamInboxItem } from "./domain";
import { requestTeamInboxItemFocusAtom, teamInboxCacheAtom } from "./store";
import { TeamInboxNotificationTracker } from "./teamInboxNotificationTracker";

const log = createLogger("TeamInboxNotifications");
const trackerByStore = new WeakMap<Store, TeamInboxNotificationTracker>();
const TEAM_INBOX_NOTIFICATION_TARGET = "team-inbox";
const TEAM_INBOX_TOAST_DURATION_MS = 8_000;

interface TeamInboxNotificationTarget {
  itemKey: string | null;
}

function trackerForStore(store: Store): TeamInboxNotificationTracker {
  const existing = trackerByStore.get(store);
  if (existing) return existing;
  const tracker = new TeamInboxNotificationTracker();
  trackerByStore.set(store, tracker);
  return tracker;
}

function compactNotificationBody(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function teamInboxNotificationExtra(
  items: readonly TeamInboxItem[]
): Record<string, unknown> {
  const itemKey =
    items.length === 1 ? getTeamInboxItemKey(items[0]) : undefined;
  return {
    orgiiTarget: TEAM_INBOX_NOTIFICATION_TARGET,
    ...(itemKey ? { teamInboxItemKey: itemKey } : {}),
  };
}

export function parseTeamInboxNotificationTarget(
  extra: Record<string, unknown> | undefined
): TeamInboxNotificationTarget | null {
  if (extra?.orgiiTarget !== TEAM_INBOX_NOTIFICATION_TARGET) return null;
  return {
    itemKey:
      typeof extra.teamInboxItemKey === "string" &&
      extra.teamInboxItemKey.length > 0
        ? extra.teamInboxItemKey
        : null,
  };
}

function openTeamInboxTarget(
  store: Store,
  title: string,
  itemKey: string | null
): void {
  if (itemKey) {
    store.set(requestTeamInboxItemFocusAtom, itemKey);
  }
  store.set(openTeamInboxInChatPanelTabAtom, title);
}

async function focusCurrentWindow(): Promise<void> {
  try {
    const currentWindow = getCurrentWindow();
    await currentWindow.show();
    await currentWindow.setFocus();
  } catch (error) {
    log.warn("Failed to focus ORGII after notification activation", error);
  }
}

/**
 * Bridges the canonical Team Inbox projection to native notifications, sound,
 * and the dock badge. The tracker is store-scoped so remounts cannot replay
 * historical unread rows.
 */
export function useTeamInboxNotifications(): void {
  const { t } = useTranslation();
  const store = useStore();
  const cache = useAtomValue(teamInboxCacheAtom);
  const settings = useAtomValue(notificationSettingsAtom);
  const teamInboxTabTitle = t("navigation:labels.inbox");
  const viewActionLabel = t("common:actions.view");

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | null = null;

    void registerTeamInboxNotificationActionType(viewActionLabel)
      .catch((error: unknown) => {
        log.error("Failed to register Team Inbox notification action", error);
      })
      .then(() =>
        listenForSystemNotificationActions(({ extra }) => {
          const target = parseTeamInboxNotificationTarget(extra);
          if (!target) return;
          openTeamInboxTarget(store, teamInboxTabTitle, target.itemKey);
          void focusCurrentWindow();
        })
      )
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          stopListening = dispose;
        }
      })
      .catch((error: unknown) => {
        log.error("Failed to listen for native notification actions", error);
      });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [store, teamInboxTabTitle, viewActionLabel]);

  useEffect(() => {
    const badgeCount =
      settings.enabled &&
      settings.dockBadgeEnabled &&
      settings.categories.teamInbox
        ? cache.unreadCount
        : 0;
    void setDockBadge(badgeCount);
  }, [
    cache.unreadCount,
    settings.categories.teamInbox,
    settings.dockBadgeEnabled,
    settings.enabled,
  ]);

  useEffect(() => {
    const newItems = trackerForStore(store).observe({
      scopeKey: cache.loadedForViewerKey,
      loading: cache.loading,
      items: cache.items,
    });
    if (newItems.length === 0) return;

    const { title, body } = notificationCopy(newItems, t);
    const extra = teamInboxNotificationExtra(newItems);
    void notifyTeamInbox(title, body, settings, extra).catch(
      (error: unknown) => {
        log.error("Failed to deliver Team Inbox notification", error);
      }
    );

    if (settings.enabled && settings.categories.teamInbox) {
      const target = parseTeamInboxNotificationTarget(extra);
      Message.info({
        title,
        content: body,
        duration: TEAM_INBOX_TOAST_DURATION_MS,
        closable: true,
        action: {
          label: viewActionLabel,
          onClick: () =>
            openTeamInboxTarget(
              store,
              teamInboxTabTitle,
              target?.itemKey ?? null
            ),
        },
      });
    }
  }, [
    cache.items,
    cache.loadedForViewerKey,
    cache.loading,
    cache.revision,
    settings,
    store,
    t,
    teamInboxTabTitle,
    viewActionLabel,
  ]);
}

export function notificationCopy(
  items: readonly TeamInboxItem[],
  t: TFunction
): { title: string; body: string } {
  if (items.length > 1) {
    return {
      title: t("teamInbox.notifications.multipleTitle", {
        count: items.length,
      }),
      body: t("teamInbox.notifications.multipleBody"),
    };
  }

  const item = items[0];
  if (item.kind === "comment_mention") {
    return {
      title: t("teamInbox.notifications.mentionTitle", {
        name: item.actor.displayName,
      }),
      body: compactNotificationBody(item.payload.commentBody),
    };
  }

  const pendingHandoff =
    item.payload.handoff?.status === "pending" ? item.payload.handoff : null;
  const assignmentTitle = t("teamInbox.notifications.assignmentTitle");
  const actorName = item.actor.displayName.trim();
  return {
    title: pendingHandoff
      ? t("teamInbox.notifications.handoffTitle", {
          name: pendingHandoff.senderName,
        })
      : actorName
        ? `${actorName} · ${assignmentTitle}`
        : assignmentTitle,
    body: compactNotificationBody(item.payload.title),
  };
}
