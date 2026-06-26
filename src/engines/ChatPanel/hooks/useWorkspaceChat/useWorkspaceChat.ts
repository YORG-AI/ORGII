/**
 * useWorkspaceChat Hook
 *
 * Manages workspace chat functionality including message sending and session interaction.
 * Orchestrates sub-hooks for dispatch and session actions.
 *
 * @example
 * const { handleSessChatSubmit, loading } = useWorkspaceChat();
 */
import { useAtomValue } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { isHostedFromSearchParams } from "@src/api/http/session/unified";
import Message from "@src/components/Message";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { createLogger } from "@src/hooks/logger";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";
import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import {
  isAgentSession,
  isCliSession,
} from "@src/util/session/sessionDispatch";

import { useSessionActions } from "./useSessionActions";
import { useUserIntentSubmit } from "./useUserIntentSubmit";

const log = createLogger("useWorkspaceChat");
interface UseWorkspaceChatOptions {
  sessionId?: string;
  sessionScope?: "active" | "none";
}

const useWorkspaceChat = (options: UseWorkspaceChatOptions = {}) => {
  const { sessionId: propSessionId, sessionScope = "active" } = options;
  const { t } = useTranslation("sessions");
  const [searchParams] = useSearchParams();

  const rawIsHosted = useMemo(
    () => isHostedFromSearchParams(searchParams),
    [searchParams]
  );
  const isSessionless = sessionScope === "none";
  const isHosted = isSessionless ? false : rawIsHosted;

  // ============================================
  // Atoms
  // ============================================
  const rawIsWpGeneWorking = useAtomValue(isSessionActiveAtom);
  const isWpGeneWorking = isSessionless ? false : rawIsWpGeneWorking;
  // SessionCore engine-level session ID — always tracks the currently
  // synced session (set by loadSessionAtom inside useSessionSync).
  const coreSessionId = useAtomValue(sessionIdAtom);

  // Unified session ID from route/atoms (fallback when coreSessionId
  // is not yet set, e.g. during initial navigation before session load).
  const { sessionId: resolvedSessionId } = useSessionId();
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const workstationActiveSessionId = useAtomValue(
    workstationActiveSessionIdAtom
  );

  // ============================================
  // Local State
  // ============================================
  const [sessChatInput, setSessChatInput] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // ============================================
  // Session ID Helper
  // ============================================
  const getSessionId = useCallback((): string | null => {
    if (sessionScope === "none") return null;
    return (
      propSessionId ||
      coreSessionId ||
      resolvedSessionId ||
      activeSessionId ||
      workstationActiveSessionId ||
      null
    );
  }, [
    propSessionId,
    sessionScope,
    coreSessionId,
    resolvedSessionId,
    activeSessionId,
    workstationActiveSessionId,
  ]);

  // ============================================
  // Sub-hooks
  // ============================================
  const submitUserIntent = useUserIntentSubmit({ getSessionId });

  const { resumeSession, interruptSession, stopSession } = useSessionActions({
    getSessionId,
  });

  // ============================================
  // Input Change Handler
  // ============================================
  const handleSessInputChange = useCallback((value: string) => {
    setSessChatInput(value);
  }, []);

  // ============================================
  // Main Chat Submit Handler
  // ============================================
  const handleSessChatSubmit = useCallback(
    async (
      e?: React.FormEvent,
      inputValue?: string,
      agentContent?: string,
      imageDataUrls?: string[]
    ) => {
      e?.preventDefault();
      const finalInput = inputValue || sessChatInput;
      if (!finalInput.trim()) return;

      const sessionId = getSessionId();
      if (!sessionId) {
        Message.error(t("errors.noSessionIdFound"));
        throw new Error("No session ID");
      }

      setLoading(true);
      try {
        await submitUserIntent({
          sessionId,
          displayContent: finalInput,
          agentContent,
          imageDataUrls,
          source: "dispatch",
          applyStopSubmitGuards: true,
          dedupeDirectSubmit: true,
          clearUserInitiatedCancelOnQueue: true,
          swallowErrorAfterUserEventAppend: true,
          onQueued: () => setSessChatInput(""),
          onBeforeDirectDispatch: () => setSessChatInput(""),
        });
      } catch (error) {
        log.error("Error sending message:", error);
        Message.error(t("errors.failedToSendMessage"));
        throw error;
      } finally {
        setLoading(false);
      }
    },
    [getSessionId, sessChatInput, submitUserIntent, t]
  );

  // ============================================
  // Send Message (Generic)
  // ============================================
  const sendMessage = useCallback(
    async (content: string) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        Message.error(t("errors.noSessionIdFound"));
        return;
      }

      setLoading(true);
      try {
        await submitUserIntent({
          sessionId,
          displayContent: content,
          source: "dispatch",
        });
      } catch (error) {
        log.error("Error sending message:", error);
        Message.error(t("errors.failedToSendMessage"));
      } finally {
        setLoading(false);
      }
    },
    [getSessionId, submitUserIntent, t]
  );

  // ============================================
  // Derived State
  // ============================================
  const effectiveSessionId = isSessionless
    ? null
    : resolvedSessionId || coreSessionId;

  const canStopAgent = useMemo(
    () =>
      isHosted ||
      (!!effectiveSessionId &&
        (isAgentSession(effectiveSessionId) ||
          isCliSession(effectiveSessionId))),
    [isHosted, effectiveSessionId]
  );

  // Resume is only meaningful for CLI-based sessions: the Rust process
  // stays alive and `cli_agent_resume` is a real tauri command. Rust-native
  // agent sessions (OS Agent, SDE Agent) have no resume — showing the orange
  // retry button for them would be dead UI. See agentDispatcher.resume which
  // throws "Agent sessions do not support resume".
  const canResume = useMemo(
    () => !!effectiveSessionId && isCliSession(effectiveSessionId),
    [effectiveSessionId]
  );

  // ============================================
  // Return Public API
  // ============================================
  return {
    sessChatInput,
    loading,
    isWpGeneWorking,

    isHosted,
    canStopAgent,
    canResume,

    handleSessInputChange,
    setSessChatInput,

    handleSessChatSubmit,
    sendMessage,

    resumeSession,
    interruptSession,
    stopSession,
  };
};

export default useWorkspaceChat;
export { useWorkspaceChat };
