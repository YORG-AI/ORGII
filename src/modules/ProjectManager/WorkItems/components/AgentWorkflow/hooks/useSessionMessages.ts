import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadMessages as agentLoadMessages,
  getSession,
} from "@src/api/tauri/agent";
import { isSubagentSpawningTool } from "@src/engines/SessionCore/sync/adapters/shared";
import { subscribeToSessionEvents } from "@src/engines/SessionCore/sync/useSessionChannel";
import { isTerminalStatus } from "@src/types/session/session";

import type { AgentMessage } from "../types";

const EVENT_SETTLE_MS = 750;
const MAX_TEXT_MESSAGES = 100;
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

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionNotifiedRef = useRef(false);
  const terminalRef = useRef(false);
  const seenSubAgentMsgIdsRef = useRef<Set<string>>(new Set());
  const onSubAgentChangeRef = useRef(onSubAgentChange);
  useEffect(() => {
    onSubAgentChangeRef.current = onSubAgentChange;
  }, [onSubAgentChange]);

  const loadMessages = useCallback(async () => {
    try {
      const result = (await agentLoadMessages(
        sessionId
      )) as unknown as AgentMessage[];
      const textMessages = result
        .filter((msg) => TEXT_ROLES.has(msg.role))
        .slice(-MAX_TEXT_MESSAGES);
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
      while (seenSubAgentMsgIdsRef.current.size > 200) {
        const firstKey = seenSubAgentMsgIdsRef.current.values().next().value;
        if (firstKey) seenSubAgentMsgIdsRef.current.delete(firstKey);
        else break;
      }
      if (hasNew) {
        onSubAgentChangeRef.current?.();
      }
    } catch {
      // Session may not exist yet
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const checkSessionStatus = useCallback(async () => {
    try {
      const session = (await getSession(sessionId)) as unknown as {
        session_id: string;
        status: string;
      } | null;
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
  }, [sessionId, onSessionComplete, onStatusChange]);

  useEffect(() => {
    let cancelled = false;
    completionNotifiedRef.current = false;
    terminalRef.current = false;

    const refresh = async () => {
      if (cancelled) return;
      await loadMessages();
      await checkSessionStatus();
    };

    void refresh();
    const scheduleRefresh = () => {
      if (cancelled || terminalRef.current || document.hidden) return;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh();
      }, EVENT_SETTLE_MS);
    };
    const unsubscribe = isRunning
      ? subscribeToSessionEvents(sessionId, scheduleRefresh)
      : () => undefined;
    const handleVisibilityOrFocus = () => {
      if (!document.hidden) scheduleRefresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    window.addEventListener("focus", handleVisibilityOrFocus);

    return () => {
      cancelled = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      window.removeEventListener("focus", handleVisibilityOrFocus);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [sessionId, isRunning, loadMessages, checkSessionStatus]);

  return {
    messages,
    loading,
    sessionStatus,
    isTerminalStatus,
  };
}
