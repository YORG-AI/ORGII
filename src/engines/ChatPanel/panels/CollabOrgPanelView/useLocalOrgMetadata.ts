import { useSetAtom } from "jotai";
import { useEffect, useState } from "react";

import { projectApi } from "@src/api/http/project";
import {
  collabProjectsAtom,
  collabWorkItemsAtom,
} from "@src/store/collaboration/collabOrgsAtom";
import { COLLAB_SYNC_BACKEND } from "@src/store/collaboration/types";
import type {
  CollabOrgRecord,
  CollabProjectMetadataRecord,
  CollabWorkItemMetadataRecord,
} from "@src/store/collaboration/types";

import { replaceOrgMetadata } from "./utils";

export function useLocalOrgMetadata(org: CollabOrgRecord | undefined) {
  const setProjects = useSetAtom(collabProjectsAtom);
  const setWorkItems = useSetAtom(collabWorkItemsAtom);
  const [localMetadataError, setLocalMetadataError] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!org || org.syncBackend === COLLAB_SYNC_BACKEND.SUPABASE) return;
    let cancelled = false;

    const loadLocalOrgMetadata = async () => {
      setLocalMetadataError(null);
      const projectData = await projectApi.readProjects({ orgId: org.id });
      if (cancelled) return;

      const nextProjects: CollabProjectMetadataRecord[] = projectData.map(
        (project) => ({
          id: project.meta.id,
          orgId: org.id,
          name: project.meta.name,
          slug: project.slug,
          status: project.meta.status,
          priority: project.meta.priority,
          health: project.meta.health,
          lead: project.meta.lead,
          description: project.description,
          updatedAt: project.meta.updated_at,
        })
      );

      const workItemGroups = await Promise.all(
        projectData.map(async (project) => {
          const enrichedWorkItems = await projectApi.readWorkItemsEnriched(
            project.slug,
            { orgId: org.id }
          );
          return enrichedWorkItems.map<CollabWorkItemMetadataRecord>(
            (workItem) => ({
              id: workItem.id,
              orgId: org.id,
              title: workItem.title,
              status: workItem.status,
              priority: workItem.priority,
              projectId: workItem.project?.id ?? project.meta.id,
              projectName: workItem.project?.name ?? project.meta.name,
              assigneeName: workItem.assignee?.name,
              updatedAt: workItem.updatedAt,
            })
          );
        })
      );
      if (cancelled) return;

      setProjects((current) =>
        replaceOrgMetadata(current, org.id, nextProjects)
      );
      setWorkItems((current) =>
        replaceOrgMetadata(current, org.id, workItemGroups.flat())
      );
    };

    void loadLocalOrgMetadata().catch((error: unknown) => {
      if (cancelled) return;
      setLocalMetadataError(
        error instanceof Error ? error.message : String(error)
      );
    });

    return () => {
      cancelled = true;
    };
  }, [org, setProjects, setWorkItems]);

  return { localMetadataError };
}
