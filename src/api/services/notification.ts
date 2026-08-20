import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { createLogger } from "@src/hooks/logger";
import type {
  BackgroundCompletionSummary,
  NotificationCategory,
  NotificationContext,
  NotificationDeliveryResult,
  NotificationSettings,
} from "@src/types/ui/notification";

import {
  NotificationEventDeduper,
  NotificationRunTracker,
  evaluateNotificationPolicy,
} from "./notificationPolicy";
import {
  type NotificationSoundPlaybackOptions,
  playNotificationSound as playSelectedNotificationSound,
  unlockNotificationSound as unlockSelectedNotificationSound,
} from "./notificationSound";
import { BackgroundCompletionSummaryCoordinator } from "./notificationSummaryCoordinator";

const log = createLogger("Notification");

export type NotificationPermissionStatus = "granted" | "denied" | "unknown";

export const TASK_FAILURE_NOTIFICATION_BODY =
  "A task failed. Open ORGII for details.";

export interface NotificationOptions {
  title: string;
  body: string;
  category?: NotificationCategory;
  playSound?: boolean;
  context?: NotificationContext;
  summaryLabel?: string;
  extra?: Record<string, unknown>;
  actionTypeId?: string;
}

interface TerminalNotificationOptions {
  title?: string;
  context?: NotificationContext;
  summaryLabel?: string;
}

type BackgroundCompletionSummaryListener = (
  summary: BackgroundCompletionSummary
) => void;

let backgroundCompletionSummaryListener: BackgroundCompletionSummaryListener | null =
  null;
let anonymousSummaryEventSequence = 0;
const notificationEventDeduper = new NotificationEventDeduper();
const notificationRunTracker = new NotificationRunTracker();

export function isPrimaryNotificationWindow(): boolean {
  try {
    return !isTauri() || getCurrentWindow().label === "main";
  } catch {
    return false;
  }
}

export function markNotificationRunStarted(sessionId: string): void {
  notificationRunTracker.markRunning(sessionId);
}

export function terminalNotificationEventKey(
  sessionId: string,
  status: "completed" | "failed"
): string {
  return notificationRunTracker.terminalEventKey(sessionId, status);
}

export interface SystemNotificationAction {
  extra: Record<string, unknown>;
}

export const TEAM_INBOX_NOTIFICATION_ACTION_TYPE_ID = "orgii-team-inbox";

/**
 * Read the native permission tri-state without collapsing "not requested" into
 * "denied". The JS plugin only exposes a boolean, so it is a fallback.
 */
export const checkNotificationPermission =
  async (): Promise<NotificationPermissionStatus> => {
    try {
      return await invoke<NotificationPermissionStatus>(
        "check_notification_permission"
      );
    } catch (invokeError) {
      log.warn(
        "[Notification] Rust permission check failed, using boolean fallback:",
        invokeError
      );
    }

    try {
      return (await isPermissionGranted()) ? "granted" : "unknown";
    } catch (error) {
      log.error("[Notification] Permission check failed:", error);
      return "unknown";
    }
  };

export const requestNotificationPermission =
  async (): Promise<NotificationPermissionStatus> => {
    try {
      const permission = await requestPermission();
      return permission === "granted"
        ? "granted"
        : permission === "denied"
          ? "denied"
          : "unknown";
    } catch (error) {
      log.warn(
        "[Notification] Permission request failed, trying Rust command:",
        error
      );
      try {
        return await invoke<NotificationPermissionStatus>(
          "request_notification_permission"
        );
      } catch (invokeError) {
        log.error(
          "[Notification] Rust permission request failed:",
          invokeError
        );
        return "unknown";
      }
    }
  };

export const sendSystemNotification = async (
  title: string,
  body: string,
  extra?: Record<string, unknown>,
  actionTypeId?: string
): Promise<boolean> => {
  try {
    await sendNotification({
      title,
      body,
      extra,
      actionTypeId,
      autoCancel: true,
    });
    return true;
  } catch (error) {
    log.warn("[Notification] Send failed, trying Rust command:", error);
    try {
      await invoke("send_notification", { title, body });
      return true;
    } catch (invokeError) {
      log.error("[Notification] Rust notification send failed:", invokeError);
      return false;
    }
  }
};

/**
 * Notification action buttons are a mobile-only concept in the notification
 * plugin: its desktop `invoke_handler` registers just notify/permission
 * commands, so `registerActionTypes` and the action listener can only fail
 * with "Command not found" on every desktop launch. Both entry points are
 * kept as inert seams for a future mobile target.
 */
export const registerTeamInboxNotificationActionType = async (
  _viewLabel: string
): Promise<void> => {};

/** See `registerTeamInboxNotificationActionType` — inert on desktop. */
export const listenForSystemNotificationActions = async (
  _handler: (action: SystemNotificationAction) => void
): Promise<() => void> => {
  return () => {};
};

/**
 * Project the authoritative Team Inbox unread count into the dock badge.
 */
export const setDockBadge = async (count: number): Promise<boolean> => {
  try {
    await invoke("set_dock_badge", {
      count: Number.isFinite(count) && count > 0 ? Math.floor(count) : null,
    });
    return true;
  } catch (error) {
    log.error("[Notification] Failed to update dock badge:", error);
    return false;
  }
};

export const playNotificationSound = (
  options: NotificationSoundPlaybackOptions
): Promise<boolean> => playSelectedNotificationSound(options);

export const unlockNotificationSound = (): Promise<boolean> =>
  unlockSelectedNotificationSound();

async function deliverNotification(
  options: NotificationOptions,
  settings: NotificationSettings,
  decision: {
    sendSystemNotification: boolean;
    playSound: boolean;
  }
): Promise<
  Pick<NotificationDeliveryResult, "systemNotificationSent" | "soundPlayed">
> {
  const systemNotificationSent = decision.sendSystemNotification
    ? await sendSystemNotification(
        options.title,
        options.body,
        options.extra,
        options.actionTypeId
      )
    : false;
  const soundPlayed = decision.playSound
    ? await playNotificationSound({
        preset: settings.soundPreset,
        volume: settings.soundVolume,
      })
    : false;

  return {
    systemNotificationSent,
    soundPlayed,
  };
}

const backgroundCompletionSummaryCoordinator =
  new BackgroundCompletionSummaryCoordinator(async (summary, settings) => {
    const visibleNames = summary.sessionNames.join(", ");
    const remaining = Math.max(0, summary.count - summary.sessionNames.length);
    const body = visibleNames
      ? remaining > 0
        ? `${visibleNames} and ${remaining} more`
        : visibleNames
      : `${summary.count} background tasks are ready for review`;
    const options: NotificationOptions = {
      title: `${summary.count} background task${summary.count === 1 ? "" : "s"} completed`,
      body,
      category: "taskCompletion",
      playSound: true,
    };
    const decision = evaluateNotificationPolicy(
      {
        category: options.category,
        playSound: true,
      },
      settings
    );

    if (decision.disposition !== "deliver") {
      return decision.reason !== "quiet-hours";
    }

    const delivery = await deliverNotification(options, settings, decision);
    let inAppDelivered = false;
    if (backgroundCompletionSummaryListener) {
      try {
        backgroundCompletionSummaryListener(summary);
        inAppDelivered = true;
      } catch (error) {
        log.error("[Notification] Summary listener failed:", error);
      }
    }

    return (
      delivery.systemNotificationSent || delivery.soundPlayed || inAppDelivered
    );
  });

/** Keep the one-shot summary boundary timer aligned with live settings. */
export function configureNotificationRuntime(
  settings: NotificationSettings
): void {
  if (!isPrimaryNotificationWindow()) return;
  backgroundCompletionSummaryCoordinator.configure(settings);
}

export function disposeNotificationRuntime(): void {
  backgroundCompletionSummaryCoordinator.dispose();
}

export function setBackgroundCompletionSummaryListener(
  listener: BackgroundCompletionSummaryListener | null
): () => void {
  backgroundCompletionSummaryListener = listener;
  return () => {
    if (backgroundCompletionSummaryListener === listener) {
      backgroundCompletionSummaryListener = null;
    }
  };
}

export const notify = async (
  options: NotificationOptions,
  settings: NotificationSettings
): Promise<NotificationDeliveryResult> => {
  if (!isPrimaryNotificationWindow()) {
    return {
      disposition: "suppressed",
      systemNotificationSent: false,
      soundPlayed: false,
      reason: "non-primary-window",
    };
  }

  const eventKey = options.context?.eventKey;
  if (eventKey && !notificationEventDeduper.shouldDeliver(eventKey)) {
    return {
      disposition: "suppressed",
      systemNotificationSent: false,
      soundPlayed: false,
      reason: "duplicate",
    };
  }

  configureNotificationRuntime(settings);
  const decision = evaluateNotificationPolicy(
    {
      category: options.category,
      context: options.context,
      playSound: options.playSound !== false,
    },
    settings
  );

  if (decision.disposition === "defer") {
    backgroundCompletionSummaryCoordinator.enqueue(
      {
        eventKey:
          options.context?.eventKey ??
          `summary:${Date.now()}:${++anonymousSummaryEventSequence}`,
        sessionId: options.context?.sessionId,
        sessionName: options.summaryLabel ?? options.body,
      },
      settings
    );
    return {
      disposition: "deferred",
      systemNotificationSent: false,
      soundPlayed: false,
      reason: decision.reason,
    };
  }

  if (decision.disposition === "suppress") {
    return {
      disposition: "suppressed",
      systemNotificationSent: false,
      soundPlayed: false,
      reason: decision.reason,
    };
  }

  const delivery = await deliverNotification(options, settings, decision);
  return {
    disposition: "delivered",
    ...delivery,
  };
};

export const notifyTaskCompletion = async (
  taskName: string,
  settings: NotificationSettings,
  options: TerminalNotificationOptions = {}
): Promise<NotificationDeliveryResult> =>
  notify(
    {
      title: options.title ?? "Task Completed",
      body: taskName,
      category: "taskCompletion",
      playSound: true,
      context: options.context,
      summaryLabel: options.summaryLabel ?? taskName,
    },
    settings
  );

export const notifyAgentApproval = async (
  actionName: string,
  settings: NotificationSettings,
  context?: NotificationContext
): Promise<NotificationDeliveryResult> =>
  notify(
    {
      title: "Action Requires Approval",
      body: actionName,
      category: "agentApproval",
      playSound: true,
      context,
    },
    settings
  );

export const notifyError = async (
  errorMessage: string,
  settings: NotificationSettings,
  options: TerminalNotificationOptions = {}
): Promise<NotificationDeliveryResult> =>
  notify(
    {
      title: options.title ?? "Error",
      body: errorMessage,
      category: "errors",
      playSound: true,
      context: options.context,
    },
    settings
  );

export const notifyTeamInbox = async (
  title: string,
  body: string,
  settings: NotificationSettings,
  extra?: Record<string, unknown>
): Promise<NotificationDeliveryResult> => {
  return notify(
    {
      title,
      body,
      category: "teamInbox",
      playSound: true,
      extra,
      actionTypeId: TEAM_INBOX_NOTIFICATION_ACTION_TYPE_ID,
    },
    settings
  );
};

/** Test the native channel and selected sound without changing saved settings. */
export const sendTestNotification = async (
  settings: NotificationSettings
): Promise<boolean> => {
  const result = await deliverNotification(
    {
      title: "Test Notification",
      body: "This is a test notification from ORGII",
      category: "taskCompletion",
      playSound: true,
    },
    settings,
    {
      sendSystemNotification: true,
      playSound: settings.soundEnabled,
    }
  );
  return result.systemNotificationSent;
};
