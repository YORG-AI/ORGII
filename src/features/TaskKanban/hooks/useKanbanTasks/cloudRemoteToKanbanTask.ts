import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";
import type { CliAgentType } from "@src/api/types/keys";
import { CLI_AGENT } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import { KANBAN_RESULT_STATUS } from "@src/features/KanbanBoard/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";
import { basename } from "@src/util/path";
import { stripPillReferences } from "@src/util/session/stripPillReferences";

import {
  type KanbanAutoArchiveTtl,
  isKanbanActivityAutoArchived,
  mapSessionStatusToKanbanColumn,
} from "../../config";
import type { KanbanTask } from "../../types";
import { resolveKanbanAgentIconId } from "./kanbanAgentBranding";

const CLOUD_REMOTE_TASK_PREFIX = "cloud-remote:";
const CLI_AGENT_TYPES = new Set<string>(Object.values(CLI_AGENT));
const FAILED_STATUSES = new Set(["failed", "error", "timeout", "killed"]);

export interface CloudRemoteKanbanProjection {
  tasks: KanbanTask[];
  remoteSessionsByTaskId: ReadonlyMap<string, RemoteTeammateSessionMetadata>;
}

export interface BuildCloudRemoteKanbanProjectionOptions {
  orgId: string;
  viewerUserId?: string;
  autoArchiveTtl: KanbanAutoArchiveTtl;
  nowMs: number;
}

function parseCliAgentType(
  value: string | undefined
): CliAgentType | undefined {
  return value && CLI_AGENT_TYPES.has(value)
    ? (value as CliAgentType)
    : undefined;
}

function importedSessionKey(
  orgId: string,
  sourceSessionId: string,
  ownerMemberId: string
): string {
  return `${orgId}\u0000${sourceSessionId}\u0000${ownerMemberId}`;
}

function resolveRemoteAgentMetadata(
  remote: RemoteTeammateSessionMetadata
): Pick<KanbanTask, "agentIconId" | "agentLabel" | "cliAgentType"> {
  const cliAgentType = parseCliAgentType(remote.cliAgentType);
  const externalOrigin =
    remote.origin?.kind === "external_history" ? remote.origin : undefined;
  const externalSource = externalOrigin
    ? IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
        (candidate) => candidate.sourceId === externalOrigin.source
      )
    : undefined;

  return {
    agentIconId:
      externalSource?.iconId ??
      resolveKanbanAgentIconId(remote.agentDefinitionId, undefined),
    agentLabel:
      remote.agentDisplayName ||
      externalSource?.displayName ||
      (remote.cliAgentType ? formatAgentType(remote.cliAgentType) : "Agent"),
    cliAgentType,
  };
}

function remoteSessionToKanbanTask(
  remote: RemoteTeammateSessionMetadata,
  options: BuildCloudRemoteKanbanProjectionOptions
): KanbanTask {
  const sourceStatus = remote.status ?? "completed";
  const statusColumn = mapSessionStatusToKanbanColumn(sourceStatus);
  const status =
    statusColumn === "turn_finished" &&
    isKanbanActivityAutoArchived(
      sourceStatus,
      remote.lastActivityAt,
      options.autoArchiveTtl,
      options.nowMs
    )
      ? "archived"
      : statusColumn;
  const agent = resolveRemoteAgentMetadata(remote);
  const workspacePath = remote.repoScopeKey ?? remote.repoPath;

  return {
    id: `${CLOUD_REMOTE_TASK_PREFIX}${remote.id}`,
    title: stripPillReferences(remote.title || remote.sourceSessionId),
    status: status as KanbanTask["status"],
    canMove: false,
    canOpen: remote.eventsEpoch !== undefined,
    tags: [remote.cliAgentType, remote.branch].filter(
      (value): value is string => Boolean(value)
    ),
    assignee: agent.agentLabel,
    ...agent,
    modelName: remote.model,
    workspaceName: workspacePath ? basename(workspacePath) : undefined,
    // Cloud session metadata currently carries last activity but not a
    // separate creation timestamp. Using it for both keeps filtering and the
    // List/Diary time axes honest about the timestamp we actually know.
    created_at: remote.lastActivityAt,
    updated_at: remote.lastActivityAt,
    completed_at:
      status === "turn_finished" || status === "archived"
        ? remote.lastActivityAt
        : undefined,
    resultStatus: FAILED_STATUSES.has(sourceStatus)
      ? KANBAN_RESULT_STATUS.Failed
      : status === "archived"
        ? KANBAN_RESULT_STATUS.Archived
        : undefined,
    createdBy: {
      id: remote.ownerMemberId || remote.ownerUserId,
      name:
        remote.ownerDisplayName.trim() ||
        remote.ownerMemberId ||
        remote.ownerUserId,
      ...(remote.ownerAvatarUrl ? { avatarUrl: remote.ownerAvatarUrl } : {}),
    },
  };
}

/**
 * Merge-ready cloud rows for Kanban/List. Local own/imported copies win so a
 * session never renders twice; teammate metadata stays ephemeral and is not
 * written into the global local-session store.
 */
export function buildCloudRemoteKanbanProjection(
  rows: readonly RemoteTeammateSessionMetadata[],
  visibleLocalSessions: readonly Session[],
  options: BuildCloudRemoteKanbanProjectionOptions
): CloudRemoteKanbanProjection {
  const tasks: KanbanTask[] = [];
  const remoteSessionsByTaskId = new Map<
    string,
    RemoteTeammateSessionMetadata
  >();
  const visibleLocalSessionIds = new Set(
    visibleLocalSessions.map((session) => session.session_id)
  );
  const visibleImportedSessionKeys = new Set(
    visibleLocalSessions.flatMap((session) => {
      const importedFrom = session.importedFrom;
      return importedFrom
        ? [
            importedSessionKey(
              importedFrom.orgId,
              importedFrom.sourceSessionId,
              importedFrom.ownerMemberId
            ),
          ]
        : [];
    })
  );

  for (const remote of rows) {
    const matchesImportedCopy = visibleImportedSessionKeys.has(
      importedSessionKey(
        options.orgId,
        remote.sourceSessionId,
        remote.ownerMemberId
      )
    );
    // A source id collision alone does not establish ownership. This mirrors
    // Team Sessions: an own row is local only when both the cloud identity and
    // local session id match.
    const matchesOwnLocalSession =
      Boolean(options.viewerUserId) &&
      remote.ownerUserId === options.viewerUserId &&
      visibleLocalSessionIds.has(remote.sourceSessionId);
    if (
      remote.orgId !== options.orgId ||
      remote.deletedAt ||
      matchesImportedCopy ||
      matchesOwnLocalSession
    ) {
      continue;
    }

    const task = remoteSessionToKanbanTask(remote, options);
    tasks.push(task);
    remoteSessionsByTaskId.set(task.id, remote);
  }

  return { tasks, remoteSessionsByTaskId };
}
