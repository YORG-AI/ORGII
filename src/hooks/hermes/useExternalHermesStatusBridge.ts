import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { notifyAgentApproval } from "@src/api/services/notification";
import {
  getHermesApprovalNotificationBody,
  shouldNotifyHermesApproval,
} from "@src/engines/ChatPanel/components/TerminalAgentHoverCard/presentation";
import {
  TERMINAL_AGENT_STATUS,
  type TerminalAgentActivity,
  type TerminalAgentStatus,
} from "@src/engines/TerminalCore/types";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";

const TERMINAL_AGENT_STATUSES = new Set<string>(
  Object.values(TERMINAL_AGENT_STATUS)
);

interface ExternalHermesStatusMessage {
  type: "terminal_agent.status_changed";
  source?: string;
  cli_agent_type?: string;
  agent_session_id?: string;
  agent_status?: string;
  tool_name?: string;
  tool_input_preview?: string;
  cwd?: string;
}

/**
 * Handles Hermes processes that were launched outside ORGII and therefore do
 * not own an ORGII terminal tab. Integrated terminals keep their tab-scoped
 * listener so notification clicks can still navigate precisely.
 */
export function useExternalHermesStatusBridge(): void {
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const lastStatusBySessionRef = useRef(new Map<string, TerminalAgentStatus>());

  useEffect(() => {
    const websocket = getCodeEditorWebSocket();
    if (!websocket) return;

    return websocket.on("terminal_agent.status_changed", (raw) => {
      const message = raw as unknown as ExternalHermesStatusMessage;
      if (
        message.source !== "external" ||
        message.cli_agent_type !== "hermes" ||
        !message.agent_status ||
        !TERMINAL_AGENT_STATUSES.has(message.agent_status)
      ) {
        return;
      }

      const sessionKey =
        message.agent_session_id || message.cwd || "external-hermes";
      const nextStatus = message.agent_status as TerminalAgentStatus;
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
          document.hidden,
          document.hasFocus()
        )
      ) {
        const activity: TerminalAgentActivity = {
          toolName: message.tool_name,
          toolInputPreview: message.tool_input_preview,
          cwd: message.cwd,
          updatedAt: Date.now(),
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
