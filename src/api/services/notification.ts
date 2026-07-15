import { invoke } from "@tauri-apps/api/core";
import {
  type Options as SystemNotification,
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { createLogger } from "@src/hooks/logger";
import { NotificationSettings } from "@src/store/ui/notificationAtom";

const log = createLogger("Notification");

// Audio element for completion sounds
let audioElement: HTMLAudioElement | null = null;
let audioContext: AudioContext | null = null;

// Initialize audio element
const getAudioElement = (): HTMLAudioElement => {
  if (!audioElement) {
    audioElement = new Audio("/sounds/completion.mp3");
    // Add error handler to fall back to generated sound
    audioElement.addEventListener("error", () => {
      log.warn("Sound file not found, using generated sound");
    });
  }
  return audioElement;
};

// Generate a simple notification beep using Web Audio API as fallback
const playGeneratedSound = (volume: number): void => {
  try {
    if (!audioContext) {
      audioContext = new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      )();
    }

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

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch (error) {
    log.error("Failed to play generated sound:", error);
  }
};

// Notification categories type
export type NotificationCategory = keyof NotificationSettings["categories"];

export interface NotificationOptions {
  title: string;
  body: string;
  category?: NotificationCategory;
  playSound?: boolean;
  extra?: Record<string, unknown>;
}

export type SystemNotificationActionHandler = (
  notification: SystemNotification
) => void;

/**
 * Check notification permission status
 */
export const checkNotificationPermission = async (): Promise<string> => {
  try {
    const granted = await isPermissionGranted();
    return granted ? "granted" : "denied";
  } catch (error) {
    log.error(
      "[Notification] Permission check failed, trying Rust command:",
      error
    );
    try {
      return await invoke<string>("check_notification_permission");
    } catch (invokeError) {
      log.error("[Notification] Rust command also failed:", invokeError);
      return "unknown";
    }
  }
};

/**
 * Request notification permission
 */
export const requestNotificationPermission = async (): Promise<string> => {
  try {
    const permission = await requestPermission();
    return permission === "granted"
      ? "granted"
      : permission === "denied"
        ? "denied"
        : "unknown";
  } catch (error) {
    log.error(
      "[Notification] Permission request failed, trying Rust command:",
      error
    );
    try {
      return await invoke<string>("request_notification_permission");
    } catch (invokeError) {
      log.error("[Notification] Rust command also failed:", invokeError);
      return "denied";
    }
  }
};

/**
 * Send a system notification
 */
export const sendSystemNotification = async (
  title: string,
  body: string,
  extra?: Record<string, unknown>
): Promise<boolean> => {
  try {
    await sendNotification({ title, body, extra });
    return true;
  } catch (error) {
    log.error("[Notification] Send failed, trying Rust command:", error);
    try {
      await invoke("send_notification", { title, body });
      return true;
    } catch (invokeError) {
      log.error("[Notification] Rust command also failed:", invokeError);
      return false;
    }
  }
};

/** Listen for a user clicking or acting on an ORGII system notification. */
export const onSystemNotificationAction = async (
  handler: SystemNotificationActionHandler
): Promise<() => Promise<void>> => {
  const listener = await onAction(handler);
  return () => listener.unregister();
};

/**
 * Play completion sound
 */
export const playCompletionSound = (volume: number = 70): void => {
  try {
    const audio = getAudioElement();
    audio.volume = Math.max(0, Math.min(1, volume / 100));
    audio.currentTime = 0;

    const playPromise = audio.play();

    if (playPromise !== undefined) {
      playPromise.catch(() => {
        // If the audio file fails to play (not found or error), use generated sound
        playGeneratedSound(volume);
      });
    }
  } catch {
    // Fallback to generated sound
    playGeneratedSound(volume);
  }
};

/**
 * Send a notification based on settings
 */
export const notify = async (
  options: NotificationOptions,
  settings: NotificationSettings
): Promise<boolean> => {
  if (!settings.enabled) {
    return false;
  }

  if (options.category && !settings.categories[options.category]) {
    return false;
  }

  let notificationSent = false;
  if (settings.systemNotificationEnabled) {
    notificationSent = await sendSystemNotification(
      options.title,
      options.body,
      options.extra
    );
  }

  if (options.playSound !== false && settings.completionSound) {
    playCompletionSound(settings.soundVolume);
  }

  return notificationSent;
};

/**
 * Notify task completion
 */
export const notifyTaskCompletion = async (
  taskName: string,
  settings: NotificationSettings
): Promise<boolean> => {
  return notify(
    {
      title: "Task Completed",
      body: taskName,
      category: "taskCompletion",
      playSound: true,
    },
    settings
  );
};

/**
 * Notify agent approval needed
 */
export const notifyAgentApproval = async (
  actionName: string,
  settings: NotificationSettings,
  extra?: Record<string, unknown>
): Promise<boolean> => {
  return notify(
    {
      title: "Action Requires Approval",
      body: actionName,
      category: "agentApproval",
      playSound: true,
      extra,
    },
    settings
  );
};

/**
 * Notify error
 */
export const notifyError = async (
  errorMessage: string,
  settings: NotificationSettings
): Promise<boolean> => {
  return notify(
    {
      title: "Error",
      body: errorMessage,
      category: "errors",
      playSound: false,
    },
    settings
  );
};

/**
 * Notify session status change
 */
export const notifySessionStatus = async (
  status: string,
  settings: NotificationSettings
): Promise<boolean> => {
  return notify(
    {
      title: "Session Status",
      body: status,
      category: "sessionStatus",
      playSound: false,
    },
    settings
  );
};

/**
 * Notify git operation
 */
export const notifyGitOperation = async (
  operation: string,
  settings: NotificationSettings
): Promise<boolean> => {
  return notify(
    {
      title: "Git Operation",
      body: operation,
      category: "gitOperations",
      playSound: false,
    },
    settings
  );
};

/**
 * Test notification - sends a test notification and plays sound
 */
export const sendTestNotification = async (
  settings: NotificationSettings
): Promise<boolean> => {
  const tempSettings = {
    ...settings,
    enabled: true,
    systemNotificationEnabled: true,
    categories: {
      ...settings.categories,
      taskCompletion: true,
    },
  };

  return notify(
    {
      title: "Test Notification",
      body: "This is a test notification from ORGII",
      category: "taskCompletion",
      playSound: true,
    },
    tempSettings
  );
};
