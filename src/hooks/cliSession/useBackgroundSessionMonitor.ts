/**
 * useBackgroundSessionMonitor Hook
 *
 * Owns the single window-level CLI lifecycle status subscription. It routes
 * every CLI status through the global coordinator and additionally delivers
 * notifications for background ("fire and forget") sessions.
 *
 * This hook runs at the app root level (via GlobalSessionSync) so it is
 * always active, regardless of which view the user is on.
 *
 * Active adapters remain responsible for transcript/UI mirroring only; turn
 * finality for active and background sessions is owned here.
 */
import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { deliverBackgroundSessionTerminalNotification } from "@src/hooks/session/backgroundSessionNotifications";
import { sessionByIdAtom } from "@src/store/session";
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
}

export function useBackgroundSessionMonitor(): void {
  const { t } = useTranslation();
  const notificationSettings = useAtomValue(notificationSettingsAtom);

  const settingsRef = useRef(notificationSettings);
  useEffect(() => {
    settingsRef.current = notificationSettings;
  }, [notificationSettings]);
  const translationRef = useRef(t);
  useEffect(() => {
    translationRef.current = t;
  }, [t]);

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

      if (!isTerminalStatus(msg.status)) return;
      if (!applied) return;
      deliverBackgroundTerminal(
        msg,
        settingsRef.current,
        translationRef.current
      );
    });

    const reconcile = () => {
      void cliTurnLifecycleCoordinator.reconcile().then((appliedStatuses) => {
        for (const status of appliedStatuses) {
          if (!isTerminalStatus(status.status)) continue;
          deliverBackgroundTerminal(
            {
              type: "code_session.status_changed",
              session_id: status.sessionId,
              status: status.status,
              turn_intent_id: status.turnIntentId,
            },
            settingsRef.current,
            translationRef.current
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

function deliverBackgroundTerminal(
  msg: BackgroundStatusMessage,
  settings: NotificationSettings,
  t: TFunction
): void {
  const session = isStoreInitialized()
    ? getInstrumentedStore().get(sessionByIdAtom(msg.session_id))
    : undefined;
  const background = msg.background ?? session?.background ?? false;
  if (!background) return;

  const sessionName =
    msg.session_name || session?.name || t("notifications.backgroundSession");

  deliverBackgroundSessionTerminalNotification(
    {
      status: msg.status,
      sessionName,
      errorMessage: msg.error_message ?? session?.error_message,
    },
    settings,
    t
  );
}
