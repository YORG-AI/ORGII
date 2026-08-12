/**
 * Pure workspace work-item fetch/merge helpers for ProjectWorkItemsTabContent.
 * Extracted to keep the tab-content component under the 600-line limit.
 */
import { enrichedWorkItemToUI, workItemDataToUI } from "@src/api/http/project";
import { isWorkspaceCompletedWorkItem } from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";

import { WORKSPACE_COMPLETED_READ_BUCKET } from "./ProjectWorkItemsTabContentConstants";
import type {
  AggregatedWorkItem,
  ReadWorkspaceBucketOptions,
} from "./ProjectWorkItemsTabContentTypes";

export function readWorkspaceBucket({
  workspaceData,
  readBucket,
  linearWorkItems,
}: ReadWorkspaceBucketOptions): AggregatedWorkItem[] {
  const orgNameById = new Map(
    workspaceData.orgs.map((org) => [org.id, org.name])
  );
  const localEntryGroups = workspaceData.projectEntries.map(
    ({ project, workItems }) =>
      workItems.map((workItem) => ({
        project,
        shortId: workItem.shortId,
        orgId: project.meta.org_id,
        orgName: orgNameById.get(project.meta.org_id),
        item: {
          ...enrichedWorkItemToUI(workItem),
          project: {
            id: project.meta.id,
            name: project.meta.name,
          },
        },
      }))
  );
  const standaloneEntries = workspaceData.standaloneWorkItems.map(
    ({ orgId: standaloneOrgId, workItem }) => ({
      shortId: workItem.frontmatter.short_id ?? workItem.frontmatter.id,
      orgId: standaloneOrgId,
      orgName: orgNameById.get(standaloneOrgId),
      item: workItemDataToUI(workItem, {
        labelMap: new Map(),
        memberMap: new Map(),
        projectNameMap: new Map(),
      }),
    })
  );
  const isCompletedBucket = readBucket === WORKSPACE_COMPLETED_READ_BUCKET;
  const linearEntries = linearWorkItems
    .filter(
      (workItem) =>
        readBucket === undefined ||
        isWorkspaceCompletedWorkItem(workItem) === isCompletedBucket
    )
    .map((workItem) => ({
      project: {
        meta: {
          id: workItem.workspaceSource?.projectId ?? "linear",
          name: workItem.workspaceSource?.projectName ?? "Linear",
        },
        slug: workItem.workspaceSource?.projectId ?? "linear",
      },
      shortId: workItem.session_id,
      orgId: "",
      item: workItem,
    }));

  return [...localEntryGroups.flat(), ...standaloneEntries, ...linearEntries];
}

export function mergeWorkspaceEntries(
  currentEntries: AggregatedWorkItem[],
  nextEntries: AggregatedWorkItem[]
): AggregatedWorkItem[] {
  const entriesById = new Map(
    currentEntries.map((entry) => [entry.item.session_id, entry])
  );
  for (const entry of nextEntries) {
    entriesById.set(entry.item.session_id, entry);
  }
  return [...entriesById.values()];
}
