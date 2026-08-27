/**
 * Owns the single window-level CLI lifecycle subscription, coordinator
 * reconciliation, and notification runtime.
 */
import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import {
  configureNotificationRuntime,
  disposeNotificationRuntime,
  isPrimaryNotificationWindow,
  markNotificationRunStarted,
  setBackgroundCompletionSummaryListener,
  terminalNotificationEventKey,
} from "@src/api/services/notification";
import {
  isNotificationAttentionRequired,
  isSuccessfulNotificationTurnStatus,
} from "@src/api/services/notificationPolicy";
import { registerNotificationSoundUnlock } from "@src/api/services/notificationSound";
import Message from "@src/components/Message";
import { deliverSessionTerminalNotification } from "@src/hooks/session/sessionTerminalNotifications";
import { activeSessionIdAtom, sessionByIdAtom } from "@src/store/session";
import {
  type NotificationSettings,
  notificationSettingsAtom,
} from "@src/store/ui/notificationAtom";
import { isTerminalStatus } from "@src/types/session/session";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import { cliTurnLifecycleCoordinator } from "./cliTurnLifecycleCoordinator";

interface BackgroundStatusMessage {
  type: "code_session.status_changed";
  session_id: string;
  status: string;
  background?: boolean;
  session_name?: string;
  error_message?: string;
  exit_code?: number;
  turn_intent_id?: string;
  plan_gate?: boolean;
}

export function useBackgroundSessionMonitor(): void {
  const { t } = useTranslation();
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const settingsRef = useRef(notificationSettings);
  const translationRef = useRef(t);

  useEffect(() => {
    settingsRef.current = notificationSettings;
    configureNotificationRuntime(notificationSettings);
  }, [notificationSettings]);

  useEffect(() => {
    translationRef.current = t;
  }, [t]);

  useEffect(() => {
    const unregisterSoundUnlock = isPrimaryNotificationWindow()
      ? registerNotificationSoundUnlock({
          shouldUnlock: () => settingsRef.current.soundEnabled,
        })
      : () => undefined;
    const reconcileRuntime = () => {
      configureNotificationRuntime(settingsRef.current);
    };
    const handleRuntimeVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcileRuntime();
    };
    const unsubscribeSummary = setBackgroundCompletionSummaryListener(
      (summary) => {
        const names = summary.sessionNames.join(", ");
        const suffix = names ? `: ${names}` : "";
        Message.success({
          content: `${summary.count} background task${summary.count === 1 ? "" : "s"} completed${suffix}`,
          duration: 8000,
          closable: true,
        });
      }
    );

    configureNotificationRuntime(settingsRef.current);
    window.addEventListener("focus", reconcileRuntime);
    window.addEventListener("pageshow", reconcileRuntime);
    document.addEventListener(
      "visibilitychange",
      handleRuntimeVisibilityChange
    );

    return () => {
      unregisterSoundUnlock();
      unsubscribeSummary();
      disposeNotificationRuntime();
      window.removeEventListener("focus", reconcileRuntime);
      window.removeEventListener("pageshow", reconcileRuntime);
      document.removeEventListener(
        "visibilitychange",
        handleRuntimeVisibilityChange
      );
    };
  }, []);

  useEffect(() => {
    const wsClient = getCodeEditorWebSocket();
    if (!wsClient) return;

    const unsubscribe = wsClient.on("code_session.status_changed", (raw) => {
      const msg = raw as unknown as BackgroundStatusMessage;
      const applied = cliTurnLifecycleCoordinator.handleStatus({
        sessionId: msg.session_id,
        status: msg.status,
        turnIntentId: msg.turn_intent_id,
      });

      if (msg.status === "running") {
        markNotificationRunStarted(msg.session_id);
        return;
      }

      const completedTurn = isSuccessfulNotificationTurnStatus(msg.status);
      const terminal = isTerminalStatus(msg.status);
      if (!completedTurn && !terminal) return;
      if (terminal && !applied) return;

      deliverCliStatus(
        msg,
        settingsRef.current,
        translationRef.current,
        completedTurn
      );
    });

    const reconcile = () => {
      void cliTurnLifecycleCoordinator.reconcile().then((appliedStatuses) => {
        for (const status of appliedStatuses) {
          const completedTurn = isSuccessfulNotificationTurnStatus(
            status.status
          );
          if (!completedTurn && !isTerminalStatus(status.status)) continue;
          deliverCliStatus(
            {
              type: "code_session.status_changed",
              session_id: status.sessionId,
              status: status.status,
              turn_intent_id: status.turnIntentId,
            },
            settingsRef.current,
            translationRef.current,
            completedTurn
          );
        }
      });
    };
    const unsubscribeConnected = wsClient.on("connected", reconcile);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", reconcile);

    return () => {
      unsubscribe();
      unsubscribeConnected();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", reconcile);
    };
  }, []);
}

function deliverCliStatus(
  msg: BackgroundStatusMessage,
  settings: NotificationSettings,
  t: TFunction,
  completedTurn: boolean
): void {
  const store = isStoreInitialized() ? getInstrumentedStore() : null;
  const session = store?.get(sessionByIdAtom(msg.session_id));
  const activeSessionId = store?.get(activeSessionIdAtom);
  const sessionInBackground = msg.background ?? session?.background ?? false;
  const outsideActiveSession =
    sessionInBackground ||
    (store !== null && activeSessionId !== msg.session_id);
  const attentionRequired =
    isNotificationAttentionRequired(outsideActiveSession);
  const sessionName =
    msg.session_name || session?.name || t("notifications.backgroundSession");

  if (completedTurn && msg.plan_gate) {
    terminalNotificationEventKey(msg.session_id, "completed");
    return;
  }

  deliverSessionTerminalNotification(
    {
      sessionId: msg.session_id,
      status: completedTurn ? "completed" : msg.status,
      sessionName,
      attentionRequired,
      errorMessage: msg.error_message ?? session?.error_message,
      eventKey:
        msg.status === "failed"
          ? terminalNotificationEventKey(msg.session_id, "failed")
          : completedTurn
            ? terminalNotificationEventKey(msg.session_id, "completed")
            : undefined,
    },
    settings,
    t
  );
}
