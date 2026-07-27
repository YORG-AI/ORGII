import { useCallback, useEffect, useRef, useState } from "react";

import {
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import type { MemberEntry } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import { toWorkItemPartialUpdate } from "@src/modules/ProjectManager/WorkItems/workItemPartialUpdate";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

import type { WorkItemTarget } from "./domain";

const log = createLogger("TeamInboxWorkItem");

interface ResolvedWorkItem {
  key: string;
  workItem: WorkItem | null;
  repoPath: string | null;
  members: Person[];
  error: string | null;
}

export interface TeamInboxWorkItemState {
  workItem: WorkItem | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  repoPath: string | null;
  members: Person[];
  updateWorkItem: (updates: Partial<WorkItem>) => void;
  refreshWorkItem: () => void;
}

/**
 * Demand-load the full Work Item for the selected inbox row.
 *
 * The resolved value is keyed to the selection, late reads are ignored after
 * cleanup, and only the newest overlapping property update may replace the
 * displayed snapshot.
 */
export function useTeamInboxWorkItem(
  target: WorkItemTarget
): TeamInboxWorkItemState {
  const { projectId, workItemId } = target;
  const requestKey = `${projectId || "standalone"}:${workItemId}`;
  const [resolved, setResolved] = useState<ResolvedWorkItem | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const updateGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const request = projectId
      ? Promise.all([
          projectApi.readWorkItem(projectId, workItemId),
          projectApi.readProject(projectId),
          projectApi.readMembers(projectId),
        ]).then(([data, project, memberFile]) => ({
          data,
          project,
          memberEntries: memberFile.members,
        }))
      : projectApi.readStandaloneWorkItem(workItemId).then((data) => ({
          data,
          project: null,
          memberEntries: [] as MemberEntry[],
        }));

    void request
      .then(({ data, project, memberEntries }) => {
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
          error: null,
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
          error: error instanceof Error ? error.message : String(error),
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
      const payload = toWorkItemPartialUpdate(updates);
      if (Object.keys(payload).length === 0) return;

      const generation = ++updateGenerationRef.current;
      void projectApi
        .updateWorkItemPartial(projectId, workItemId, payload)
        .then((updated) => {
          if (generation !== updateGenerationRef.current) return;
          setResolved((current) =>
            current?.key === requestKey
              ? {
                  key: requestKey,
                  workItem: {
                    ...enrichedWorkItemToUI(updated),
                    project: current.workItem?.project,
                  },
                  repoPath: current.repoPath,
                  members: current.members,
                  error: null,
                }
              : current
          );
        })
        .catch((error: unknown) => {
          if (generation !== updateGenerationRef.current) return;
          log.warn("Failed to update Team Inbox Work Item", error);
          setResolved((current) =>
            current?.key === requestKey
              ? {
                  ...current,
                  error: error instanceof Error ? error.message : String(error),
                }
              : current
          );
        });
    },
    [projectId, requestKey, workItemId]
  );

  if (resolved?.key !== requestKey) {
    return {
      workItem: null,
      status: "loading",
      error: null,
      repoPath: null,
      members: [],
      updateWorkItem,
      refreshWorkItem,
    };
  }

  return {
    workItem: resolved.workItem,
    status: resolved.workItem ? "ready" : "error",
    error: resolved.error,
    repoPath: resolved.repoPath,
    members: resolved.members,
    updateWorkItem,
    refreshWorkItem,
  };
}
