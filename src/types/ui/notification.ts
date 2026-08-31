import type { NotificationSoundPreset } from "@src/config/notificationSounds";

export type NotificationCategory =
  | "taskCompletion"
  | "agentApproval"
  | "errors"
  | "teamInbox";

export interface NotificationQuietHoursSettings {
  enabled: boolean;
  start: string;
  end: string;
  allowCritical: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  systemNotificationEnabled: boolean;
  dockBadgeEnabled: boolean;
  soundEnabled: boolean;
  soundPreset: NotificationSoundPreset;
  soundVolume: number;
  criticalOnly: boolean;
  quietHours: NotificationQuietHoursSettings;
  backgroundCompletionSummary: boolean;
  categories: Record<NotificationCategory, boolean>;
}

export interface NotificationContext {
  sessionId?: string;
  /** True when the session or its main window is outside user attention. */
  background?: boolean;
  /** Stable-enough key used to collapse duplicate live event deliveries. */
  eventKey?: string;
}

export type NotificationDisposition = "delivered" | "deferred" | "suppressed";

export interface NotificationDeliveryResult {
  disposition: NotificationDisposition;
  systemNotificationSent: boolean;
  soundPlayed: boolean;
  reason?:
    | "disabled"
    | "category-disabled"
    | "critical-only"
    | "duplicate"
    | "foreground-session"
    | "non-primary-window"
    | "quiet-hours";
}

export interface BackgroundCompletionSummary {
  count: number;
  sessionNames: readonly string[];
}
