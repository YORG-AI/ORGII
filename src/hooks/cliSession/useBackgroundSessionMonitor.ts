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
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import {
  notifyError,
  notifyTaskCompletion,
} from "@src/api/services/notification";
import Message from "@src/components/Message";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";
import { isTerminalStatus } from "@src/types/session/session";

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
  const notificationSettings = useAtomValue(notificationSettingsAtom);

  const settingsRef = useRef(notificationSettings);
  useEffect(() => {
    settingsRef.current = notificationSettings;
  }, [notificationSettings]);

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

      if (!msg.background) return;
      if (!isTerminalStatus(msg.status)) return;
      if (!applied) return;

      const sessionName = msg.session_name || "Background session";

      if (msg.status === "completed") {
        notifyTaskCompletion(
          `"${sessionName}" completed — ready for review`,
          settingsRef.current
        );

        Message.success({
          content: `"${sessionName}" completed. Click to review diff.`,
          duration: 0,
          closable: true,
        });
      } else if (msg.status === "failed") {
        const errorDetail = msg.error_message
          ? `: ${msg.error_message.slice(0, 120)}`
          : "";

        notifyError(
          `"${sessionName}" failed${errorDetail}`,
          settingsRef.current
        );

        Message.error({
          content: `"${sessionName}" failed${errorDetail}`,
          duration: 8000,
          closable: true,
        });
      } else if (msg.status === "cancelled") {
        Message.warning({
          content: `"${sessionName}" was cancelled`,
          duration: 5000,
        });
      }
    });

    const reconcile = () => {
      void cliTurnLifecycleCoordinator.reconcile();
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
