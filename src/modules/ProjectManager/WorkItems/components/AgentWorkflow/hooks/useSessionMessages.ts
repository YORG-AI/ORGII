import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadMessages as agentLoadMessages,
  getSession,
} from "@src/api/tauri/agent";
import { isSubagentSpawningTool } from "@src/engines/SessionCore/sync/adapters/shared";
import { useVisiblePolling } from "@src/hooks/async";
import { isTerminalStatus } from "@src/types/session/session";

import type { AgentMessage } from "../types";

const POLL_INTERVAL_MS = 3000;
const MAX_TOOL_MESSAGES = 30;
const TEXT_ROLES = new Set(["user", "assistant"]);

interface UseSessionMessagesOptions {
  sessionId: string;
  isRunning: boolean;
  onSessionComplete?: () => void;
  onStatusChange?: (status: string) => void;
  onSubAgentChange?: () => void;
}

export function useSessionMessages(options: UseSessionMessagesOptions) {
  const {
    sessionId,
    isRunning,
    onSessionComplete,
    onStatusChange,
    onSubAgentChange,
  } = options;

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);

  const completionNotifiedRef = useRef(false);
  const terminalRef = useRef(false);
  const seenSubAgentMsgIdsRef = useRef<Set<string>>(new Set());
  const onSubAgentChangeRef = useRef(onSubAgentChange);
  useEffect(() => {
    onSubAgentChangeRef.current = onSubAgentChange;
  }, [onSubAgentChange]);

  const loadMessages = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = (await agentLoadMessages(
          sessionId
        )) as unknown as AgentMessage[];
        if (signal?.aborted) return;
        const textMessages = result.filter((msg) => TEXT_ROLES.has(msg.role));
        const toolMessages = result
          .filter((msg) => !TEXT_ROLES.has(msg.role))
          .slice(-MAX_TOOL_MESSAGES);
        const merged = [...textMessages, ...toolMessages].sort(
          (msgA, msgB) => msgA.sequence - msgB.sequence
        );
        setMessages(merged);

        let hasNew = false;
        for (const msg of result) {
          if (
            msg.tool_name &&
            isSubagentSpawningTool(msg.tool_name) &&
            !seenSubAgentMsgIdsRef.current.has(msg.id)
          ) {
            seenSubAgentMsgIdsRef.current.add(msg.id);
            hasNew = true;
          }
        }
        if (seenSubAgentMsgIdsRef.current.size > 200) {
          const firstKey = seenSubAgentMsgIdsRef.current.values().next().value;
          if (firstKey) seenSubAgentMsgIdsRef.current.delete(firstKey);
        }
        if (hasNew) {
          onSubAgentChangeRef.current?.();
        }
      } catch {
        // Session may not exist yet
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [sessionId]
  );

  const checkSessionStatus = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const session = (await getSession(sessionId)) as unknown as {
          session_id: string;
          status: string;
        } | null;
        if (signal?.aborted) return;
        const status = session?.status ?? null;
        setSessionStatus(status);
        if (status) onStatusChange?.(status);
        if (status && isTerminalStatus(status)) {
          terminalRef.current = true;
          if (!completionNotifiedRef.current) {
            completionNotifiedRef.current = true;
            onSessionComplete?.();
          }
        }
      } catch {
        // ignore
      }
    },
    [sessionId, onSessionComplete, onStatusChange]
  );

  const pollSession = useCallback(
    async (signal: AbortSignal) => {
      await loadMessages(signal);
      if (signal.aborted) return false;
      await checkSessionStatus(signal);
      return !signal.aborted && isRunning && !terminalRef.current;
    },
    [checkSessionStatus, isRunning, loadMessages]
  );

  useEffect(() => {
    completionNotifiedRef.current = false;
    terminalRef.current = false;
  }, [sessionId]);

  useVisiblePolling({
    enabled: true,
    intervalMs: POLL_INTERVAL_MS,
    poll: pollSession,
  });

  return {
    messages,
    loading,
    sessionStatus,
    isTerminalStatus,
  };
}
