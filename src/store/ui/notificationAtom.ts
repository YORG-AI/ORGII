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

export interface NotificationSettings {
  enabled: boolean;
  systemNotificationEnabled: boolean;
  dockBadgeEnabled: boolean;
  completionSound: boolean;
  soundVolume: number;
  categories: {
    taskCompletion: boolean;
    errors: boolean;
    teamInbox: boolean;
  };
}

export const notificationSettingsAtom = atom<NotificationSettings>((get) => {
  const settings = get(settingsAtom);
  return {
    enabled: settings["notifications.enabled"],
    systemNotificationEnabled:
      settings["notifications.systemNotificationEnabled"],
    dockBadgeEnabled: settings["notifications.dockBadgeEnabled"],
    completionSound: settings["notifications.completionSound"],
    soundVolume: settings["notifications.soundVolume"],
    categories: {
      taskCompletion: settings["notifications.categories.taskCompletion"],
      errors: settings["notifications.categories.errors"],
      teamInbox: settings["notifications.categories.teamInbox"],
    },
  };
});
notificationSettingsAtom.debugLabel = "notificationSettingsAtom";
