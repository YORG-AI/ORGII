import { z } from "zod";

import type { SettingDefinition } from "@src/config/settingsSchema/types";

export const NOTIFICATIONS_SETTINGS_REGISTRY = {
  "notifications.enabled": {
    schema: z.boolean(),
    default: true,
    description: "Master toggle for all notifications",
    category: "notifications",
  },
  "notifications.completionSound": {
    schema: z.boolean(),
    default: true,
    description: "Play a sound when a task completes",
    category: "notifications",
  },
  "notifications.systemNotificationEnabled": {
    schema: z.boolean(),
    default: false,
    description: "Enable native system notifications",
    category: "notifications",
  },
  "notifications.dockBadgeEnabled": {
    schema: z.boolean(),
    default: false,
    description: "Show notification badge on app dock icon",
    category: "notifications",
  },
  "notifications.soundVolume": {
    schema: z.number().min(0).max(100),
    default: 70,
    description: "Notification sound volume (0-100)",
    category: "notifications",
  },
  "notifications.categories.taskCompletion": {
    schema: z.boolean(),
    default: true,
    description: "Show notifications for task/session completion",
    category: "notifications",
  },
  "notifications.categories.errors": {
    schema: z.boolean(),
    default: true,
    description: "Show notifications for errors and warnings",
    category: "notifications",
  },
  "notifications.categories.teamInbox": {
    schema: z.boolean(),
    default: true,
    description:
      "Show notifications for Team Inbox assignments, mentions, and handoffs",
    category: "notifications",
  },
} as const satisfies Record<string, SettingDefinition>;
