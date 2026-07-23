import { KANBAN_RESULT_STATUS } from "@src/features/KanbanBoard/types";
import type { Session } from "@src/store/session";
import {
  isAgentSession,
  isCliSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";
import { stripPillReferences } from "@src/util/session/stripPillReferences";

import {
  type AgentKanbanColumnId,
  type KanbanAutoArchiveTtl,
  mapSessionToKanbanColumn,
} from "../../config";
import type { KanbanResultStatus, KanbanTask } from "../../types";
import { resolveKanbanAgentFilter } from "./kanbanAgentFilter";

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
  const display = resolveSessionDisplayMetadata({
    kind: "local",
    session,
  });
  const agentFilter = resolveKanbanAgentFilter(
    display,
    session.agentDefinitionId
  );
  const tags: string[] = [categoryTag];
  if (display.cliAgentType) tags.push(display.cliAgentType);
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

  return {
    id: session.session_id,
    title: stripPillReferences(
      session.name || session.user_input?.slice(0, 120) || session.session_id
    ),
    // Session names are commonly generated from the first user message, so
    // repeating `user_input` as a description produces duplicate card copy.
    description: undefined,
    status: columnId as KanbanTask["status"],
    assignee: display.agentLabel,
    tags,
    agentLabel: display.agentLabel,
    agentIconId: display.agentIconId,
    cliAgentType: display.cliAgentType,
    ...agentFilter,
    modelName: display.modelName,
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
