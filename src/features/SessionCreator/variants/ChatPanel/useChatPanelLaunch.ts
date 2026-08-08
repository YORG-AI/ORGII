/**
 * SessionCreatorChatPanel — Launch Hook
 *
 * Extracts the Work-log (human session) creation flow, the CLI TUI launch
 * flow, and the human-session composer state (title/creating) from
 * SessionCreatorChatPanel to keep the component file under the 600-line
 * limit.
 */
import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import { type RefObject, useCallback, useRef, useState } from "react";

import {
  cliAgentCreateTuiSession,
  deriveExpectedProcess,
  resolveCliTuiCommand,
} from "@src/api/tauri/agent/cliTerminalSession";
import { createHumanSession } from "@src/api/tauri/humanSession";
import type { CliAgentType } from "@src/api/types/keys";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import Message from "@src/components/Message";
import type { AvailableAgent } from "@src/config/cliAgents";
import type { ChatPanelCliTerminalLaunchOptions } from "@src/engines/ChatPanel/types";
import { getWorktreeFields } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/launchPayload";
import type {
  SessionLaunchSuccessInfo,
  SessionLaunchWorkItemContext,
} from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { createLogger } from "@src/hooks/logger";
import { worktreeLaunchSelectionAtom } from "@src/store/session";
import type { SessionSource } from "@src/store/session/creatorStateAtom";
import { runningLocationAtom } from "@src/store/session/runningLocationAtom";
import { loadSessions } from "@src/store/session/sessionAtom/loaders";

const log = createLogger("ChatPanel");

function isCliAgentType(
  value: string | null | undefined
): value is CliAgentType {
  return Boolean(value);
}

interface UseChatPanelLaunchOptions {
  isHumanMode: boolean;
  isCliTuiMode: boolean;
  composerInputRef: RefObject<ComposerInputRef | null>;
  effectiveSource: SessionSource | null;
  handleContentChangeWithTracking: (text: string) => void;
  handleSessionStart: (info: SessionLaunchSuccessInfo) => void;
  onOpenCliTerminal?: (options: ChatPanelCliTerminalLaunchOptions) => void;
  selectedCliAgent: AvailableAgent | undefined;
  cliAgentType: CliAgentType | null;
  chatPanelLaunchContext: SessionLaunchWorkItemContext;
  originalHandleLaunch: () => Promise<boolean>;
  setAttachedWorkItemContext: (
    context: SessionLaunchWorkItemContext | null
  ) => void;
  t: TFunction<"sessions">;
}

export function useChatPanelLaunch({
  isHumanMode,
  isCliTuiMode,
  composerInputRef,
  effectiveSource,
  handleContentChangeWithTracking,
  handleSessionStart,
  onOpenCliTerminal,
  selectedCliAgent,
  cliAgentType,
  chatPanelLaunchContext,
  originalHandleLaunch,
  setAttachedWorkItemContext,
  t,
}: UseChatPanelLaunchOptions) {
  const runningLocation = useAtomValue(runningLocationAtom);
  const worktreeLaunchSelection = useAtomValue(worktreeLaunchSelectionAtom);

  const [humanTitle, setHumanTitle] = useState("");
  const humanCreatingRef = useRef(false);
  const [humanCreating, setHumanCreating] = useState(false);

  // ── Launch ────────────────────────────────────────────────────────────────

  const handleLaunch = useCallback(async () => {
    if (isHumanMode) {
      const note = composerInputRef.current?.getTextWithPills().trim() ?? "";
      if (!note || humanCreatingRef.current) return;
      humanCreatingRef.current = true;
      setHumanCreating(true);
      try {
        const humanSession = await createHumanSession({
          body: note,
          title: humanTitle.trim() || undefined,
          workspacePath: effectiveSource?.repoPath,
        });
        composerInputRef.current?.clear();
        setHumanTitle("");
        handleContentChangeWithTracking("");
        await loadSessions({ forceRefresh: true }).catch(() => undefined);
        handleSessionStart({ sessionId: humanSession.sessionId });
      } catch (error) {
        Message.error(
          error instanceof Error
            ? error.message
            : t("humanSession.createFailed")
        );
      } finally {
        humanCreatingRef.current = false;
        setHumanCreating(false);
      }
      return;
    }

    if (
      isCliTuiMode &&
      onOpenCliTerminal &&
      selectedCliAgent &&
      isCliAgentType(cliAgentType)
    ) {
      const command = await resolveCliTuiCommand(
        cliAgentType,
        selectedCliAgent.command.trim()
      );
      if (command.length > 0) {
        // Back the TUI terminal with a managed session row so the worktree
        // selection is honored (cwd below) and lifecycle hooks can attribute
        // status/transcripts via ORGII_SESSION_ID. Creation failure degrades
        // to the old unbound repo-root terminal rather than blocking launch.
        const repoPath = effectiveSource?.repoPath;
        let cwd = repoPath;
        let agentSessionId: string | undefined;
        try {
          const worktreeFields = getWorktreeFields({
            runningLocation,
            repoId: effectiveSource?.repoId,
            repoPath,
            worktreeLaunchSelection,
          });
          const created = await cliAgentCreateTuiSession({
            platform: cliAgentType,
            name: selectedCliAgent.displayName,
            repoPath,
            isolate: worktreeFields.isolate,
            worktreeBaseRef: worktreeFields.worktreeBaseRef,
            worktreePath: worktreeFields.worktreePath,
            orgId: chatPanelLaunchContext.orgId,
          });
          agentSessionId = created.sessionId;
          cwd = created.worktreePath || repoPath;
        } catch (error) {
          log.warn(
            "TUI session create failed; opening unbound terminal",
            error
          );
        }
        onOpenCliTerminal({
          cliAgentType,
          command,
          title: selectedCliAgent.displayName,
          cwd,
          agentSessionId,
          expectedProcess: deriveExpectedProcess(command),
        });
        setAttachedWorkItemContext(null);
        return;
      }
    }

    return originalHandleLaunch();
  }, [
    cliAgentType,
    composerInputRef,
    chatPanelLaunchContext.orgId,
    effectiveSource?.repoId,
    effectiveSource?.repoPath,
    handleContentChangeWithTracking,
    handleSessionStart,
    humanTitle,
    isHumanMode,
    isCliTuiMode,
    onOpenCliTerminal,
    originalHandleLaunch,
    runningLocation,
    selectedCliAgent,
    setAttachedWorkItemContext,
    t,
    worktreeLaunchSelection,
  ]);

  return {
    handleLaunch,
    humanTitle,
    setHumanTitle,
    humanCreating,
  };
}
