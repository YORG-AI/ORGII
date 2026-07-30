import type { TFunction } from "i18next";
import { useAtomValue, useStore } from "jotai";
import type { Store } from "jotai/vanilla/store";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { notifyTeamInbox, setDockBadge } from "@src/api/services/notification";
import { createLogger } from "@src/hooks/logger";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";

import type { TeamInboxItem } from "./domain";
import { teamInboxCacheAtom } from "./store";
import { TeamInboxNotificationTracker } from "./teamInboxNotificationTracker";

const log = createLogger("TeamInboxNotifications");
const trackerByStore = new WeakMap<Store, TeamInboxNotificationTracker>();

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
    void notifyTeamInbox(title, body, settings).catch((error: unknown) => {
      log.error("Failed to deliver Team Inbox notification", error);
    });
  }, [
    cache.items,
    cache.loadedForViewerKey,
    cache.loading,
    cache.revision,
    settings,
    store,
    t,
  ]);
}

function notificationCopy(
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
  return {
    title: pendingHandoff
      ? t("teamInbox.notifications.handoffTitle", {
          name: pendingHandoff.senderName,
        })
      : t("teamInbox.notifications.assignmentTitle"),
    body: compactNotificationBody(item.payload.title),
  };
}
