import { useAtomValue } from "jotai";
import { useMemo } from "react";

import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import { AGENT_ROLE, type AgentRole, toAgentRole } from "../constants";

const RUNNING_LINKED_SESSION_STATUS = "running" as const;
const COMPLETED_WORK_ITEM_STATUS = "completed" as const;

/**
 * Read-only projection of the work item's active execution: which linked
 * session (if any) is currently running, and the repo paths PR creation
 * needs. Purely derived from persisted data — the execution lock and
 * linked-session rows the backend maintains.
 */
export function useWorkItemActiveSession(
  workItem: WorkItemExtended,
  repoPath?: string | null
): {
  activeAgentSessionId: string | null;
  activeAgentRole: AgentRole | null;
  worktreePath: string | null;
  projectRepoPath: string | null;
} {
  const worktreePath = useAtomValue(activeWorkspaceRootPathAtom) || null;
  const projectRepoPath = repoPath ?? null;

  const { activeAgentSessionId, activeAgentRole } = useMemo(() => {
    const runningLinkedSession =
      workItem.linkedSessions?.find(
        (session) => session.status === RUNNING_LINKED_SESSION_STATUS
      ) ?? null;
    const isCompletedWorkItem =
      workItem.workItemStatus === COMPLETED_WORK_ITEM_STATUS ||
      workItem.status === COMPLETED_WORK_ITEM_STATUS;
    const hasTerminalOnlyLinkedSessions =
      (workItem.linkedSessions?.length ?? 0) > 0 && !runningLinkedSession;
    const activeExecutionLockSessionId =
      isCompletedWorkItem || hasTerminalOnlyLinkedSessions
        ? null
        : (workItem.executionLock?.activeSessionId ?? null);
    const sessionId =
      activeExecutionLockSessionId ?? runningLinkedSession?.session_id ?? null;
    return {
      activeAgentSessionId: sessionId,
      activeAgentRole: sessionId
        ? (toAgentRole(runningLinkedSession?.agent_role) ?? AGENT_ROLE.Sde)
        : null,
    };
  }, [
    workItem.executionLock?.activeSessionId,
    workItem.linkedSessions,
    workItem.status,
    workItem.workItemStatus,
  ]);

  return {
    activeAgentSessionId,
    activeAgentRole,
    worktreePath,
    projectRepoPath,
  };
}
