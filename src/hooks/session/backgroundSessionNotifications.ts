import type { TFunction } from "i18next";

import {
  notifyError,
  notifyTaskCompletion,
} from "@src/api/services/notification";
import Message from "@src/components/Message";
import type { NotificationSettings } from "@src/store/ui/notificationAtom";
import { isTerminalStatus } from "@src/types/session/session";

export interface BackgroundSessionTerminalNotification {
  status: string;
  sessionName: string;
  errorMessage?: string;
}

export function shouldDeliverBackgroundSessionTerminalNotification(
  previousStatus: string | undefined,
  nextStatus: string,
  background: boolean
): boolean {
  return (
    background &&
    isTerminalStatus(nextStatus) &&
    (previousStatus === undefined || !isTerminalStatus(previousStatus))
  );
}

export function deliverBackgroundSessionTerminalNotification(
  event: BackgroundSessionTerminalNotification,
  settings: NotificationSettings,
  t: TFunction
): void {
  if (event.status === "completed") {
    const body = t("notifications.taskCompletedBody", {
      name: event.sessionName,
    });
    void notifyTaskCompletion(
      body,
      settings,
      t("notifications.taskCompletedTitle")
    );
    Message.success({
      content: t("notifications.taskCompletedToast", {
        name: event.sessionName,
      }),
      duration: 0,
      closable: true,
    });
    return;
  }

  if (event.status === "failed") {
    const detail = event.errorMessage
      ? `: ${event.errorMessage.slice(0, 120)}`
      : "";
    const body = t("notifications.taskFailedBody", {
      name: event.sessionName,
      detail,
    });
    void notifyError(body, settings, t("notifications.taskFailedTitle"));
    Message.error({
      content: body,
      duration: 8000,
      closable: true,
    });
    return;
  }

  if (event.status === "cancelled") {
    Message.warning({
      content: t("notifications.taskCancelledToast", {
        name: event.sessionName,
      }),
      duration: 5000,
    });
  }
}
