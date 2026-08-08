/**
 * Notification Settings
 *
 * Backed by the central settings system (~/.orgii/settings.jsonc).
 * The flat settings keys are assembled into the NotificationSettings interface
 * for read-only consumers (write paths use the slot-row controls in
 * `Settings/renderer/slots/Notifications*`, which call `useSetting` directly).
 */
import { atom } from "jotai";

import { settingsAtom } from "@src/store/settings/settingsAtom";
import type { NotificationSettings } from "@src/types/ui/notification";

export type { NotificationSettings } from "@src/types/ui/notification";

export const notificationSettingsAtom = atom<NotificationSettings>((get) => {
  const settings = get(settingsAtom);
  return {
    enabled: settings["notifications.enabled"],
    systemNotificationEnabled:
      settings["notifications.systemNotificationEnabled"],
    dockBadgeEnabled: settings["notifications.dockBadgeEnabled"],
    soundEnabled: settings["notifications.completionSound"],
    soundPreset: settings["notifications.soundPreset"],
    soundVolume: settings["notifications.soundVolume"],
    criticalOnly: settings["notifications.criticalOnly"],
    quietHours: {
      enabled: settings["notifications.quietHours.enabled"],
      start: settings["notifications.quietHours.start"],
      end: settings["notifications.quietHours.end"],
      allowCritical: settings["notifications.quietHours.allowCritical"],
    },
    backgroundCompletionSummary:
      settings["notifications.backgroundCompletionSummary"],
    mutedSessionIds: settings["notifications.mutedSessionIds"],
    categories: {
      taskCompletion: settings["notifications.categories.taskCompletion"],
      agentApproval: settings["notifications.categories.agentApproval"],
      errors: settings["notifications.categories.errors"],
      teamInbox: settings["notifications.categories.teamInbox"],
    },
  };
});
notificationSettingsAtom.debugLabel = "notificationSettingsAtom";
