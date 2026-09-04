/** Shared delivery boundary for CLI and native session terminal events. */
import type { TFunction } from "i18next";

import {
  TASK_FAILURE_NOTIFICATION_BODY,
  notifyError,
  notifyTaskCompletion,
} from "@src/api/services/notification";
import Message from "@src/components/Message";
import type { NotificationSettings } from "@src/store/ui/notificationAtom";
import { isTerminalStatus } from "@src/types/session/session";

export interface SessionTerminalNotification {
  sessionId: string;
  status: string;
  sessionName: string;
  attentionRequired: boolean;
  errorMessage?: string;
  eventKey?: string;
}

export function shouldDeliverSessionTerminalNotification(
  previousStatus: string | undefined,
  nextStatus: string
): boolean {
  return (
    isTerminalStatus(nextStatus) &&
    (previousStatus === undefined || !isTerminalStatus(previousStatus))
  );
}

export function deliverSessionTerminalNotification(
  event: SessionTerminalNotification,
  settings: NotificationSettings,
  t: TFunction
): void {
  const context = {
    sessionId: event.sessionId,
    background: event.attentionRequired,
    ...(event.eventKey ? { eventKey: event.eventKey } : {}),
  };

  if (event.status === "completed" || event.status === "idle") {
    const body = t("notifications.taskCompletedBody", {
      name: event.sessionName,
    });
    void notifyTaskCompletion(body, settings, {
      title: t("notifications.taskCompletedTitle"),
      context,
      summaryLabel: event.sessionName,
    }).then((result) => {
      if (result.disposition !== "delivered" || !event.attentionRequired)
        return;
      Message.success({
        content: t("notifications.taskCompletedToast", {
          name: event.sessionName,
        }),
        duration: 0,
        closable: true,
        // The copy says "open the Session" — give it an actual door.
        action: {
          label: t("notifications.openSessionAction", {
            defaultValue: "Open Session",
          }),
          onClick: () => {
            void Promise.all([
              import("@src/util/core/state/instrumentedStore"),
              import("@src/store/chatPanel/chatPanelTabsAtom"),
            ]).then(([storeModule, tabsModule]) => {
              storeModule
                .getInstrumentedStore()
                .set(tabsModule.openOrFocusSessionInChatPanelTabAtom, {
                  sessionId: event.sessionId,
                  sessionName: event.sessionName,
                });
            });
          },
        },
      });
    });
    return;
  }

  if (event.status === "failed") {
    const detail = event.errorMessage
      ? `: ${event.errorMessage.slice(0, 120)}`
      : "";
    const toastBody = t("notifications.taskFailedBody", {
      name: event.sessionName,
      detail,
    });
    void notifyError(TASK_FAILURE_NOTIFICATION_BODY, settings, {
      title: t("notifications.taskFailedTitle"),
      context,
    }).then((result) => {
      if (result.disposition !== "delivered" || !event.attentionRequired)
        return;
      Message.error({
        content: toastBody,
        duration: 8000,
        closable: true,
      });
    });
    return;
  }

  if (
    event.status === "cancelled" &&
    event.attentionRequired &&
    settings.enabled
  ) {
    Message.warning({
      content: t("notifications.taskCancelledToast", {
        name: event.sessionName,
      }),
      duration: 5000,
    });
  }
}
