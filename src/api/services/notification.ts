import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { createLogger } from "@src/hooks/logger";
import type { NotificationSettings } from "@src/store/ui/notificationAtom";

const log = createLogger("Notification");

let audioContext: AudioContext | null = null;

export type NotificationPermissionStatus = "granted" | "denied" | "unknown";

export interface NotificationDeliveryResult {
  systemSent: boolean;
  soundPlayed: boolean;
}

const playGeneratedSound = async (volume: number): Promise<boolean> => {
  try {
    if (!audioContext) {
      const AudioContextConstructor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextConstructor) return false;
      audioContext = new AudioContextConstructor();
    }
    if (audioContext.state === "suspended") await audioContext.resume();

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Pleasant notification sound
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5 note
    oscillator.type = "sine";

    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(
      volume / 100,
      audioContext.currentTime + 0.01
    );
    gainNode.gain.exponentialRampToValueAtTime(
      0.001,
      audioContext.currentTime + 0.3
    );

    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        gainNode.disconnect();
      },
      { once: true }
    );
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
    return true;
  } catch (error) {
    log.error("Failed to play generated sound:", error);
    return false;
  }
};

// Notification categories type
export type NotificationCategory = keyof NotificationSettings["categories"];

export interface NotificationOptions {
  title: string;
  body: string;
  category?: NotificationCategory;
  playSound?: boolean;
}

/**
 * Check notification permission status
 */
export const checkNotificationPermission =
  async (): Promise<NotificationPermissionStatus> => {
    // The Rust boundary exposes the full granted / denied / not-yet-requested
    // state. The JS helper only returns a boolean and would collapse
    // "unknown" into "denied".
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

/**
 * Request notification permission
 */
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

/**
 * Send a system notification
 */
export const sendSystemNotification = async (
  title: string,
  body: string
): Promise<boolean> => {
  try {
    await sendNotification({ title, body });
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

/**
 * Play the generated notification tone.
 */
export const playCompletionSound = async (
  volume: number = 70
): Promise<boolean> => {
  return playGeneratedSound(Math.max(0, Math.min(100, volume)));
};

/**
 * Send a notification based on settings
 */
export const notify = async (
  options: NotificationOptions,
  settings: NotificationSettings
): Promise<NotificationDeliveryResult> => {
  if (!settings.enabled) {
    return { systemSent: false, soundPlayed: false };
  }

  if (options.category && !settings.categories[options.category]) {
    return { systemSent: false, soundPlayed: false };
  }

  let systemSent = false;
  if (settings.systemNotificationEnabled) {
    systemSent = await sendSystemNotification(options.title, options.body);
  }

  let soundPlayed = false;
  if (options.playSound !== false && settings.completionSound) {
    soundPlayed = await playCompletionSound(settings.soundVolume);
  }

  return { systemSent, soundPlayed };
};

/**
 * Notify task completion
 */
export const notifyTaskCompletion = async (
  taskName: string,
  settings: NotificationSettings,
  title = "Task Completed"
): Promise<NotificationDeliveryResult> => {
  return notify(
    {
      title,
      body: taskName,
      category: "taskCompletion",
      playSound: true,
    },
    settings
  );
};

/**
 * Notify error
 */
export const notifyError = async (
  errorMessage: string,
  settings: NotificationSettings,
  title = "Error"
): Promise<NotificationDeliveryResult> => {
  return notify(
    {
      title,
      body: errorMessage,
      category: "errors",
      playSound: false,
    },
    settings
  );
};

/**
 * Notify a new Team Inbox assignment, mention, or handoff.
 */
export const notifyTeamInbox = async (
  title: string,
  body: string,
  settings: NotificationSettings
): Promise<NotificationDeliveryResult> => {
  return notify(
    {
      title,
      body,
      category: "teamInbox",
      playSound: true,
    },
    settings
  );
};

/**
 * Test the native notification channel without changing persisted settings.
 */
export const sendTestNotification = async (): Promise<boolean> =>
  sendSystemNotification(
    "Test Notification",
    "This is a test notification from ORGII"
  );
