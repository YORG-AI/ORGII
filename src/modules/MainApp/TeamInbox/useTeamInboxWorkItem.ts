import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import type { MemberEntry } from "@src/api/http/project";
import type { WorkItemHandoffTransition } from "@src/api/http/project";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { loadCloudOrgMembers } from "@src/features/Org2Cloud/org2CloudMembersCoordinator";
import { org2CloudRosterVersionAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { createLogger } from "@src/hooks/logger";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import { toWorkItemPartialUpdate } from "@src/modules/ProjectManager/WorkItems/workItemPartialUpdate";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

import { type WorkItemTarget, resolveWorkItemMemberIdentities } from "./domain";

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
  transitionHandoff: (
    transition: WorkItemHandoffTransition
  ) => Promise<WorkItem>;
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
  onWorkItemUpdated?: (workItem: WorkItem) => void,
  observedUpdatedAt?: string
): TeamInboxWorkItemState {
  const store = useStore();
  const auth = useAtomValue(org2CloudAuthAtom);
  const rosterVersions = useAtomValue(org2CloudRosterVersionAtom);
  const { orgId, projectId, workItemId } = target;
  const rosterVersion = orgId ? (rosterVersions[orgId] ?? 0) : 0;
  const requestKey = `${orgId}:${projectId || "standalone"}:${workItemId}`;
  const [resolved, setResolved] = useState<ResolvedWorkItem | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const onWorkItemUpdatedRef = useRef(onWorkItemUpdated);
  const updateQueueByKeyRef = useRef(new Map<string, Promise<void>>());
  const updateQueueSizeByKeyRef = useRef(new Map<string, number>());
  const activeMembers =
    resolved?.key === requestKey ? resolved.members : EMPTY_MEMBERS;
  const activeProject =
    resolved?.key === requestKey ? resolved.workItem?.project : undefined;
  const { currentUser } = useCurrentUserMemberIds(activeMembers);

  useEffect(() => {
    onWorkItemUpdatedRef.current = onWorkItemUpdated;
  }, [onWorkItemUpdated]);

  useEffect(() => {
    let cancelled = false;

    const request = projectId
      ? Promise.allSettled([
          projectApi.readWorkItem(projectId, workItemId),
          projectApi.readProject(projectId),
          projectApi.readMembers(projectId),
        ]).then(([workItemResult, projectResult, membersResult]) => {
          if (workItemResult.status === "rejected") {
            throw workItemResult.reason;
          }
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
            data: workItemResult.value,
            project:
              projectResult.status === "fulfilled" ? projectResult.value : null,
            memberEntries:
              membersResult.status === "fulfilled"
                ? membersResult.value.members
                : [],
            issue,
          };
        })
      : Promise.all([
          projectApi.readStandaloneWorkItem(
            workItemId,
            orgId ? { orgId } : undefined
          ),
          auth && orgId
            ? loadCloudOrgMembers(store, auth, orgId, rosterVersion).catch(
                () => null
              )
            : Promise.resolve(null),
        ]).then(([data, roster]) => ({
          data,
          project: null,
          memberEntries: (roster?.members ?? [])
            .filter((member) => member.status === "active")
            .map<MemberEntry>((member) => ({
              id: member.userId,
              name: member.displayName?.trim() || member.userId,
              active: true,
            })),
          issue:
            auth && orgId && !roster ? ("context_unavailable" as const) : null,
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
        const resolvedWorkItem = resolveWorkItemMemberIdentities(
          project
            ? {
                ...converted,
                project: {
                  id: project.slug,
                  name: project.meta.name,
                },
              }
            : converted,
          members
        );
        onWorkItemUpdatedRef.current?.(resolvedWorkItem);
        setResolved({
          key: requestKey,
          workItem: resolvedWorkItem,
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
  }, [
    observedUpdatedAt,
    auth,
    orgId,
    projectId,
    refreshGeneration,
    requestKey,
    rosterVersion,
    store,
    workItemId,
  ]);

  const refreshWorkItem = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

  const updateWorkItem = useCallback(
    (updates: Partial<WorkItem>) => {
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
          const converted = projectId
            ? enrichedWorkItemToUI(
                await projectApi.updateWorkItemPartial(
                  projectId,
                  workItemId,
                  payload
                )
              )
            : enrichedWorkItemToUI(
                standaloneWorkItemDataToEnriched(
                  await projectApi.updateStandaloneWorkItemPartial(
                    workItemId,
                    payload,
                    orgId ? { orgId } : undefined
                  )
                )
              );
          const resolvedConverted = resolveWorkItemMemberIdentities(
            activeProject
              ? { ...converted, project: activeProject }
              : converted,
            activeMembers
          );
          onWorkItemUpdatedRef.current?.(resolvedConverted);
          setResolved((current) =>
            current?.key === requestKey
              ? {
                  key: requestKey,
                  workItem: resolvedConverted,
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
    [
      activeMembers,
      activeProject,
      currentUser,
      orgId,
      projectId,
      requestKey,
      workItemId,
    ]
  );

  const transitionHandoff = useCallback(
    async (transition: WorkItemHandoffTransition): Promise<WorkItem> => {
      const data = projectId
        ? await projectApi.transitionWorkItemHandoff(
            projectId,
            workItemId,
            transition
          )
        : await projectApi.transitionStandaloneWorkItemHandoff(
            workItemId,
            transition,
            orgId ? { orgId } : undefined
          );
      const converted = enrichedWorkItemToUI(
        standaloneWorkItemDataToEnriched(data)
      );
      const resolvedConverted = resolveWorkItemMemberIdentities(
        activeProject ? { ...converted, project: activeProject } : converted,
        activeMembers
      );
      setResolved((current) =>
        current?.key === requestKey
          ? {
              ...current,
              workItem: resolvedConverted,
              issue:
                current.issue === "context_unavailable" ? current.issue : null,
            }
          : current
      );
      onWorkItemUpdatedRef.current?.(resolvedConverted);
      return resolvedConverted;
    },
    [activeMembers, activeProject, orgId, projectId, requestKey, workItemId]
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
      transitionHandoff,
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
    transitionHandoff,
    refreshWorkItem,
  };
}
