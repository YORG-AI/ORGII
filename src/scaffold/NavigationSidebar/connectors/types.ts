export type GroupByMode = "byTime" | "byAgent" | "byWorkspace";

export const GROUP_BY_MODES: readonly GroupByMode[] = [
  "byTime",
  "byWorkspace",
  "byAgent",
];

export type ProjectsGroupByMode =
  | "byOrg"
  | "byProject"
  | "byStatus"
  | "byPriority";

export const PROJECTS_GROUP_BY_MODES: readonly ProjectsGroupByMode[] = [
  "byOrg",
  "byProject",
  "byStatus",
  "byPriority",
];

export const NO_WORKSPACE_KEY = "__no_workspace__";

export const LOAD_MORE_PREFIX = "load-more-";
export const LOAD_MORE_GROUP_PREFIX = "load-more-group-";
export const LOAD_MORE_SCOPE_PREFIX = "load-more-scope-";
export const LOAD_MORE_PINNED_ID = "load-more-sidebar-pinned";
export const LOAD_MORE_WORKSPACE_FACETS_ID =
  "load-more-sidebar-workspace-facets";
