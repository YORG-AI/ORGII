export type GroupByMode = "byTime" | "byAgent" | "byWorkspace";

export const GROUP_BY_MODES: readonly GroupByMode[] = [
  "byTime",
  "byWorkspace",
  "byAgent",
];

export const SESSION_GROUP_VISIBLE_COUNTS = [5, 10] as const;
export type SessionGroupVisibleCount =
  (typeof SESSION_GROUP_VISIBLE_COUNTS)[number];
export const DEFAULT_SESSION_GROUP_VISIBLE_COUNT: SessionGroupVisibleCount = 10;

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
