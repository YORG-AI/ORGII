import { z } from "zod";

import {
  DEFAULT_NOTIFICATION_SOUND_PRESET,
  NOTIFICATION_SOUND_PRESETS,
} from "@src/config/notificationSounds";
import type { SettingDefinition } from "@src/config/settingsSchema/types";

const CLOCK_TIME_SCHEMA = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour time (HH:mm)");

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
    description: "Play sounds for audible notification categories",
    category: "notifications",
  },
  "notifications.soundPreset": {
    schema: z.enum(NOTIFICATION_SOUND_PRESETS),
    default: DEFAULT_NOTIFICATION_SOUND_PRESET,
    description: "Built-in sound preset used for audible notifications",
    category: "notifications",
    enumLabels: {
      classic: "Classic",
      gentle: "Gentle",
      ascending: "Ascending",
      bell: "Bell",
    },
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
  "notifications.criticalOnly": {
    schema: z.boolean(),
    default: false,
    description:
      "Only notify for approval requests and errors, regardless of other enabled categories",
    category: "notifications",
  },
  "notifications.quietHours.enabled": {
    schema: z.boolean(),
    default: false,
    description: "Enable a daily do-not-disturb schedule",
    category: "notifications",
  },
  "notifications.quietHours.start": {
    schema: CLOCK_TIME_SCHEMA,
    default: "23:00",
    description: "Daily do-not-disturb start time in local time (HH:mm)",
    category: "notifications",
  },
  "notifications.quietHours.end": {
    schema: CLOCK_TIME_SCHEMA,
    default: "08:00",
    description: "Daily do-not-disturb end time in local time (HH:mm)",
    category: "notifications",
  },
  "notifications.quietHours.allowCritical": {
    schema: z.boolean(),
    default: true,
    description:
      "Allow approval requests and errors during quiet hours without playing sound",
    category: "notifications",
  },
  "notifications.backgroundCompletionSummary": {
    schema: z.boolean(),
    default: true,
    description:
      "Combine background task completions suppressed by quiet hours into one notification",
    category: "notifications",
  },
  "notifications.categories.taskCompletion": {
    schema: z.boolean(),
    default: true,
    description: "Show notifications for task/session completion",
    category: "notifications",
  },
  "notifications.categories.agentApproval": {
    schema: z.boolean(),
    default: true,
    description: "Show notifications when an agent needs approval",
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
