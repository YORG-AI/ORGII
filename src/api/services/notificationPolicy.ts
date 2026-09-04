import type {
  NotificationCategory,
  NotificationContext,
  NotificationSettings,
} from "@src/types/ui/notification";

const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_EVENT_DEDUPE_TTL_MS = 30_000;
const DEFAULT_EVENT_DEDUPE_MAX_ENTRIES = 512;
const DEFAULT_RUN_TRACKER_MAX_ENTRIES = 512;

export class NotificationEventDeduper {
  private readonly seenAt = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_EVENT_DEDUPE_TTL_MS,
    private readonly maxEntries = DEFAULT_EVENT_DEDUPE_MAX_ENTRIES
  ) {}

  shouldDeliver(key: string, now: number = Date.now()): boolean {
    for (const [entryKey, timestamp] of this.seenAt) {
      if (now - timestamp > this.ttlMs) {
        this.seenAt.delete(entryKey);
      }
    }

    if (this.seenAt.has(key)) return false;
    while (this.seenAt.size >= this.maxEntries) {
      const oldestKey = this.seenAt.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.seenAt.delete(oldestKey);
    }
    this.seenAt.set(key, now);
    return true;
  }

  clear(): void {
    this.seenAt.clear();
  }

  forget(key: string): void {
    this.seenAt.delete(key);
  }
}

export class NotificationRunTracker {
  private readonly sessions = new Map<
    string,
    { generation: number; running: boolean }
  >();

  constructor(private readonly maxEntries = DEFAULT_RUN_TRACKER_MAX_ENTRIES) {}

  markRunning(sessionId: string): void {
    const current = this.sessions.get(sessionId);
    const next = {
      generation: current ? current.generation + (current.running ? 0 : 1) : 1,
      running: true,
    };
    this.remember(sessionId, next);
  }

  terminalEventKey(sessionId: string, status: string): string {
    const current = this.sessions.get(sessionId) ?? {
      generation: 0,
      running: false,
    };
    this.remember(sessionId, { ...current, running: false });
    return `terminal:${sessionId}:${current.generation}:${status}`;
  }

  private remember(
    sessionId: string,
    state: { generation: number; running: boolean }
  ): void {
    this.sessions.delete(sessionId);
    while (this.sessions.size >= this.maxEntries) {
      const oldestSessionId = this.sessions.keys().next().value as
        | string
        | undefined;
      if (!oldestSessionId) break;
      this.sessions.delete(oldestSessionId);
    }
    this.sessions.set(sessionId, state);
  }
}

export interface NotificationPolicyRequest {
  category?: NotificationCategory;
  context?: NotificationContext;
  playSound: boolean;
}

export interface NotificationPolicyDecision {
  disposition: "deliver" | "defer" | "suppress";
  sendSystemNotification: boolean;
  playSound: boolean;
  reason?:
    | "disabled"
    | "category-disabled"
    | "critical-only"
    | "foreground-session"
    | "quiet-hours";
}

interface NotificationAttentionDocument {
  readonly visibilityState: DocumentVisibilityState;
  hasFocus(): boolean;
}

/**
 * Treat the notification as background work whenever its session is not the
 * active one or the main document is hidden/unfocused.
 */
export function isNotificationAttentionRequired(
  sessionInBackground: boolean,
  currentDocument: NotificationAttentionDocument | null = typeof document ===
  "undefined"
    ? null
    : document
): boolean {
  if (sessionInBackground) return true;
  if (!currentDocument) return false;
  return (
    currentDocument.visibilityState !== "visible" || !currentDocument.hasFocus()
  );
}

export function clockTimeToMinutes(value: string): number {
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return 0;
  }
  return hour * 60 + minute;
}

function localMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function isQuietHoursActive(
  settings: NotificationSettings,
  now: Date = new Date()
): boolean {
  if (!settings.quietHours.enabled) return false;

  const start = clockTimeToMinutes(settings.quietHours.start);
  const end = clockTimeToMinutes(settings.quietHours.end);
  if (start === end) return false;

  const current = localMinutes(now);
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

export function nextQuietHoursEnd(
  settings: NotificationSettings,
  now: Date = new Date()
): Date | null {
  if (!isQuietHoursActive(settings, now)) return null;

  const start = clockTimeToMinutes(settings.quietHours.start);
  const end = clockTimeToMinutes(settings.quietHours.end);
  const current = localMinutes(now);
  const result = new Date(now);
  result.setSeconds(0, 0);
  result.setHours(Math.floor(end / 60), end % 60, 0, 0);

  if (start > end && current >= start) {
    result.setDate(result.getDate() + 1);
  }
  return result;
}

export function isCriticalNotification(
  category?: NotificationCategory
): boolean {
  return category === "agentApproval" || category === "errors";
}

/**
 * Agent Org members return to `idle` after a successful turn so they remain
 * available for more work. For notification purposes that is still a
 * completed reply boundary, just not a terminal session state.
 */
export function isSuccessfulNotificationTurnStatus(status: string): boolean {
  return status === "completed" || status === "idle";
}

export function evaluateNotificationPolicy(
  request: NotificationPolicyRequest,
  settings: NotificationSettings,
  now: Date = new Date()
): NotificationPolicyDecision {
  const deliver = (playSound: boolean): NotificationPolicyDecision => ({
    disposition: "deliver",
    sendSystemNotification:
      settings.systemNotificationEnabled &&
      request.context?.background !== false,
    playSound: playSound && settings.soundEnabled,
  });

  if (!settings.enabled) {
    return {
      disposition: "suppress",
      sendSystemNotification: false,
      playSound: false,
      reason: "disabled",
    };
  }

  if (request.category && !settings.categories[request.category]) {
    return {
      disposition: "suppress",
      sendSystemNotification: false,
      playSound: false,
      reason: "category-disabled",
    };
  }

  const critical = isCriticalNotification(request.category);
  if (settings.criticalOnly && !critical) {
    return {
      disposition: "suppress",
      sendSystemNotification: false,
      playSound: false,
      reason: "critical-only",
    };
  }

  // A completion cue is only useful when the user is no longer attending the
  // session. Approval and error alerts remain eligible in the foreground.
  if (
    request.category === "taskCompletion" &&
    request.context?.background === false
  ) {
    return {
      disposition: "suppress",
      sendSystemNotification: false,
      playSound: false,
      reason: "foreground-session",
    };
  }

  if (!isQuietHoursActive(settings, now)) {
    return deliver(request.playSound);
  }

  if (critical && settings.quietHours.allowCritical) {
    return {
      disposition: "deliver",
      sendSystemNotification:
        settings.systemNotificationEnabled &&
        request.context?.background !== false,
      // Quiet hours never play audio, including for critical alerts.
      playSound: false,
    };
  }

  if (
    request.category === "taskCompletion" &&
    request.context?.background &&
    settings.backgroundCompletionSummary
  ) {
    return {
      disposition: "defer",
      sendSystemNotification: false,
      playSound: false,
      reason: "quiet-hours",
    };
  }

  return {
    disposition: "suppress",
    sendSystemNotification: false,
    playSound: false,
    reason: "quiet-hours",
  };
}

export const NOTIFICATION_DAY_MINUTES = MINUTES_PER_DAY;
