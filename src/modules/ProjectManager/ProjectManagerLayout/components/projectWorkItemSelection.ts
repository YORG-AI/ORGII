import type {
  AggregatedWorkItem,
  ProjectWorkItemSelection,
} from "./ProjectWorkItemsTabContentTypes";

/** Canonical mapping shared by in-pane selection and dedicated-tab opening. */
export function toProjectWorkItemSelection(
  entry: AggregatedWorkItem
): ProjectWorkItemSelection {
  return {
    workItem: entry.item,
    shortId: entry.shortId,
    orgId: entry.orgId,
    orgName: entry.orgName,
    projectId: entry.project?.meta.id,
    projectName: entry.project?.meta.name,
    projectSlug: entry.project?.slug,
  };
}
