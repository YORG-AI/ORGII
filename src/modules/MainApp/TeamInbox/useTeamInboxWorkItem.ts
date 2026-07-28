import { useCallback, useEffect, useRef, useState } from "react";

import {
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import type { MemberEntry } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import { toWorkItemPartialUpdate } from "@src/modules/ProjectManager/WorkItems/workItemPartialUpdate";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

import type { WorkItemTarget } from "./domain";

const log = createLogger("TeamInboxWorkItem");
const EMPTY_MEMBERS: Person[] = [];
const MAX_PENDING_WORK_ITEM_UPDATES = 50;

interface ResolvedWorkItem {
  key: string;
  workItem: WorkItem | null;
  repoPath: string | null;
  members: Person[];
  issue: TeamInboxWorkItemIssue | null;
}

export type TeamInboxWorkItemIssue =
  | "context_unavailable"
  | "load_failed"
  | "update_failed";

export interface TeamInboxWorkItemState {
  workItem: WorkItem | null;
  status: "loading" | "ready" | "error";
  issue: TeamInboxWorkItemIssue | null;
  repoPath: string | null;
  members: Person[];
  currentUser: Person | null;
  updateWorkItem: (updates: Partial<WorkItem>) => void;
  refreshWorkItem: () => void;
}

/**
 * Demand-load the full Work Item for the selected inbox row.
 *
 * The resolved value is keyed to the selection, late reads are ignored after
 * cleanup, and updates for one Work Item are serialized in invocation order so
 * an older response can never overwrite a newer user intent.
 */
export function useTeamInboxWorkItem(
  target: WorkItemTarget,
  onWorkItemUpdated?: (workItem: WorkItem) => void
): TeamInboxWorkItemState {
  const { projectId, workItemId } = target;
  const requestKey = `${projectId || "standalone"}:${workItemId}`;
  const [resolved, setResolved] = useState<ResolvedWorkItem | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const updateQueueByKeyRef = useRef(new Map<string, Promise<void>>());
  const updateQueueSizeByKeyRef = useRef(new Map<string, number>());
  const activeMembers =
    resolved?.key === requestKey ? resolved.members : EMPTY_MEMBERS;
  const { currentUser } = useCurrentUserMemberIds(activeMembers);

  useEffect(() => {
    let cancelled = false;

    const request = projectId
      ? projectApi.readWorkItem(projectId, workItemId).then(async (data) => {
          const [projectResult, membersResult] = await Promise.allSettled([
            projectApi.readProject(projectId),
            projectApi.readMembers(projectId),
          ]);
          const issue =
            projectResult.status === "rejected" ||
            membersResult.status === "rejected"
              ? ("context_unavailable" as const)
              : null;
          if (issue) {
            log.warn(
              "Loaded Team Inbox Work Item without complete project context",
              projectResult.status === "rejected"
                ? projectResult.reason
                : membersResult.status === "rejected"
                  ? membersResult.reason
                  : undefined
            );
          }
          return {
            data,
            project:
              projectResult.status === "fulfilled" ? projectResult.value : null,
            memberEntries:
              membersResult.status === "fulfilled"
                ? membersResult.value.members
                : [],
            issue,
          };
        })
      : projectApi.readStandaloneWorkItem(workItemId).then((data) => ({
          data,
          project: null,
          memberEntries: [] as MemberEntry[],
          issue: null,
        }));

    void request
      .then(({ data, project, memberEntries, issue }) => {
        if (cancelled) return;
        const converted = enrichedWorkItemToUI(
          standaloneWorkItemDataToEnriched(data)
        );
        const activeMembers = new Map<string, MemberEntry>();
        for (const member of memberEntries) {
          if (member.active === false) continue;
          const existing = activeMembers.get(member.id);
          if (
            !existing ||
            (member.last_commit_date ?? "") > (existing.last_commit_date ?? "")
          ) {
            activeMembers.set(member.id, member);
          }
        }
        const members = [...activeMembers.values()].map<Person>((member) => ({
          id: member.id,
          name: member.name,
          email: member.email,
          avatar: member.avatar,
        }));
        const resolvedAssignee = converted.assignee
          ? (members.find((member) => member.id === converted.assignee?.id) ??
            converted.assignee)
          : undefined;
        setResolved({
          key: requestKey,
          workItem: project
            ? {
                ...converted,
                assignee: resolvedAssignee,
                project: {
                  id: project.slug,
                  name: project.meta.name,
                },
              }
            : converted,
          repoPath: project?.meta.linked_repos[0] ?? null,
          members,
          issue,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn("Failed to load Team Inbox Work Item", error);
        setResolved((current) => ({
          key: requestKey,
          workItem: current?.key === requestKey ? current.workItem : null,
          repoPath: current?.key === requestKey ? current.repoPath : null,
          members: current?.key === requestKey ? current.members : [],
          issue: "load_failed",
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, refreshGeneration, requestKey, workItemId]);

  const refreshWorkItem = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

  const updateWorkItem = useCallback(
    (updates: Partial<WorkItem>) => {
      if (!projectId) return;
      const payload = toWorkItemPartialUpdate(updates, currentUser);
      if (Object.keys(payload).length === 0) return;
      const pendingCount = updateQueueSizeByKeyRef.current.get(requestKey) ?? 0;
      if (pendingCount >= MAX_PENDING_WORK_ITEM_UPDATES) {
        log.warn("Rejected excessive queued Team Inbox Work Item updates");
        setResolved((current) =>
          current?.key === requestKey
            ? { ...current, issue: "update_failed" }
            : current
        );
        return;
      }
      updateQueueSizeByKeyRef.current.set(requestKey, pendingCount + 1);

      const runUpdate = async () => {
        try {
          const updated = await projectApi.updateWorkItemPartial(
            projectId,
            workItemId,
            payload
          );
          const converted = enrichedWorkItemToUI(updated);
          onWorkItemUpdated?.(converted);
          setResolved((current) =>
            current?.key === requestKey
              ? {
                  key: requestKey,
                  workItem: {
                    ...converted,
                    project: current.workItem?.project,
                  },
                  repoPath: current.repoPath,
                  members: current.members,
                  issue:
                    current.issue === "context_unavailable"
                      ? current.issue
                      : null,
                }
              : current
          );
        } catch (error) {
          log.warn("Failed to update Team Inbox Work Item", error);
          setResolved((current) =>
            current?.key === requestKey
              ? {
                  ...current,
                  issue: "update_failed",
                }
              : current
          );
        }
      };
      const previous =
        updateQueueByKeyRef.current.get(requestKey) ?? Promise.resolve();
      const queued = previous.then(runUpdate, runUpdate);
      updateQueueByKeyRef.current.set(requestKey, queued);
      void queued.finally(() => {
        const remaining = Math.max(
          0,
          (updateQueueSizeByKeyRef.current.get(requestKey) ?? 1) - 1
        );
        if (remaining === 0) {
          updateQueueSizeByKeyRef.current.delete(requestKey);
        } else {
          updateQueueSizeByKeyRef.current.set(requestKey, remaining);
        }
        if (updateQueueByKeyRef.current.get(requestKey) === queued) {
          updateQueueByKeyRef.current.delete(requestKey);
        }
      });
    },
    [currentUser, onWorkItemUpdated, projectId, requestKey, workItemId]
  );

  if (resolved?.key !== requestKey) {
    return {
      workItem: null,
      status: "loading",
      issue: null,
      repoPath: null,
      members: [],
      currentUser,
      updateWorkItem,
      refreshWorkItem,
    };
  }

  return {
    workItem: resolved.workItem,
    status: resolved.workItem ? "ready" : "error",
    issue: resolved.issue,
    repoPath: resolved.repoPath,
    members: resolved.members,
    currentUser,
    updateWorkItem,
    refreshWorkItem,
  };
}
