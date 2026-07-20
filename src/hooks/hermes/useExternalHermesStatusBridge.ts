import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { notifyAgentApproval } from "@src/api/services/notification";
import {
  getHermesApprovalNotificationBody,
  isExternalHermesNotificationOwner,
  shouldNotifyHermesApproval,
} from "@src/engines/ChatPanel/components/TerminalAgentHoverCard/presentation";
import {
  TERMINAL_AGENT_STATUS,
  type TerminalAgentActivity,
  type TerminalAgentStatus,
  isTerminalAgentStatus,
} from "@src/engines/TerminalCore/types";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";

/**
 * Handles Hermes processes that were launched outside ORGII and therefore do
 * not own an ORGII terminal tab. Integrated terminals keep their tab-scoped
 * listener so notification clicks can still navigate precisely.
 */
export function useExternalHermesStatusBridge(): void {
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const lastStatusBySessionRef = useRef(new Map<string, TerminalAgentStatus>());

  useEffect(() => {
    if (!isExternalHermesNotificationOwner(getCurrentWindow().label)) return;
    const websocket = getCodeEditorWebSocket();
    if (!websocket) return;

    return websocket.on("terminal_agent.status_changed", (message) => {
      if (
        message.source !== "external" ||
        message.cli_agent_type !== "hermes" ||
        !isTerminalAgentStatus(message.agent_status)
      ) {
        return;
      }

      const sessionKey =
        message.agent_session_id || message.cwd || "external-hermes";
      const nextStatus = message.agent_status;
      const previousStatus = lastStatusBySessionRef.current.get(sessionKey);
      if (nextStatus === TERMINAL_AGENT_STATUS.DONE) {
        lastStatusBySessionRef.current.delete(sessionKey);
      } else {
        lastStatusBySessionRef.current.set(sessionKey, nextStatus);
      }

      if (
        shouldNotifyHermesApproval(
          previousStatus,
          nextStatus,
          document.hidden || !document.hasFocus()
        )
      ) {
        const activity: TerminalAgentActivity = {
          toolName: message.tool_name,
          toolInputPreview: message.tool_input_preview,
          cwd: message.cwd,
          updatedAt: message.timestamp,
        };
        void notifyAgentApproval(
          `External Hermes: ${getHermesApprovalNotificationBody(activity)}`,
          notificationSettings,
          {
            kind: "hermes-external-approval",
            agentSessionId: message.agent_session_id,
          }
        );
      }
    });
  }, [notificationSettings]);
}
