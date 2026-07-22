import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import { formatAgentType } from "@src/assets/providers";
import { KANBAN_RESULT_STATUS } from "@src/features/KanbanBoard/types";
import type { Session } from "@src/store/session";
import {
  isAgentSession,
  isCliSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";
import { stripPillReferences } from "@src/util/session/stripPillReferences";

import {
  type AgentKanbanColumnId,
  type KanbanAutoArchiveTtl,
  mapSessionToKanbanColumn,
} from "../../config";
import type { KanbanResultStatus, KanbanTask } from "../../types";
import { resolveKanbanAgentIconId } from "./kanbanAgentBranding";

function getResultStatus(
  session: Session,
  columnId: AgentKanbanColumnId
): KanbanResultStatus | undefined {
  if (columnId === "archived") return KANBAN_RESULT_STATUS.Archived;

  switch (session.status) {
    case "failed":
    case "error":
    case "timeout":
    case "killed":
      return KANBAN_RESULT_STATUS.Failed;
    default:
      return undefined;
  }
}

function getCategoryTag(session: Session): string {
  if (isAgentSession(session.session_id)) return "Agent";
  if (isCliSession(session.session_id)) return "CLI";
  if (isCursorIdeSession(session.session_id)) return "Cursor";
  return "Other";
}

function getAgentLabel(session: Session, categoryTag: string): string {
  const importedSource = getImportedHistorySourceBySessionId(
    session.session_id
  );
  if (importedSource) return importedSource.displayName;
  if (session.cliAgentType === "claude_code") return "Claude CLI";
  if (session.cliAgentType) return formatAgentType(session.cliAgentType);
  return session.agentDisplayName || categoryTag;
}

function getWorkspaceName(session: Session): string | undefined {
  const repoName = session.repo_name?.trim();
  if (repoName) return repoName;

  // A worktree's basename is an internal generated identifier (for example,
  // `sdeagent-97c3d918-5dec`), not the workspace the user selected. Prefer the
  // persisted repo root and keep worktreePath only as a legacy fallback.
  const workspacePath = session.repoPath || session.worktreePath;
  if (!workspacePath) return undefined;

  return workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath;
}

export function sessionToKanbanTask(
  session: Session,
  visitedSessions: ReadonlySet<string>,
  manualArchivedSessionIds: ReadonlySet<string>,
  autoArchiveTtl: KanbanAutoArchiveTtl,
  nowMs: number
): KanbanTask {
  const categoryTag = getCategoryTag(session);
  const tags: string[] = [categoryTag];
  if (session.cliAgentType) tags.push(session.cliAgentType);
  if (session.repo_name) tags.push(session.repo_name);
  if (session.worktreeBranch) tags.push(session.worktreeBranch);
  if (session.mergeStatus && session.mergeStatus !== "pending") {
    tags.push(`merge: ${session.mergeStatus}`);
  }

  const columnId = mapSessionToKanbanColumn(session, {
    manualArchivedSessionIds,
    autoArchiveTtl,
    nowMs,
  });

  const isCompleted = session.status === "completed";
  const isUnread = isCompleted && !visitedSessions.has(session.session_id);
  const resultStatus = getResultStatus(session, columnId);
  const agentLabel = getAgentLabel(session, categoryTag);

  return {
    id: session.session_id,
    title: stripPillReferences(
      session.name || session.user_input?.slice(0, 120) || session.session_id
    ),
    // Session names are commonly generated from the first user message, so
    // repeating `user_input` as a description produces duplicate card copy.
    description: undefined,
    status: columnId as KanbanTask["status"],
    assignee: agentLabel,
    tags,
    agentLabel,
    agentIconId: resolveKanbanAgentIconId(
      session.agentDefinitionId,
      session.agentIconId
    ),
    cliAgentType: session.cliAgentType,
    modelName: session.model,
    totalTokens: session.totalTokens,
    workspaceName: getWorkspaceName(session),
    created_at: session.created_at,
    updated_at: session.updated_at,
    completed_at: session.completed_at,
    session_id: session.session_id,
    isUnread,
    resultStatus,
  };
}
