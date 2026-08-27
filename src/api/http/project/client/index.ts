/**
 * Project store Tauri client.
 *
 * Thin `invoke()` wrappers for the `project_*` commands. All calls
 * are slug-keyed — the old `repoPath` boundary is gone, and projects
 * are listed from the global store.
 *
 * Split by command family; `scope.ts` holds the shared `orgId` helpers and is
 * intentionally not re-exported (internal to the client).
 */
export * from "./assets";
export * from "./batch";
export * from "./collabSync";
export * from "./discussions";
export * from "./labels";
export * from "./members";
export * from "./milestones";
export * from "./orgs";
export * from "./projects";
export * from "./routineWebhooks";
export * from "./routines";
export * from "./workItemProperties";
export * from "./workItems";
export * from "./workRuns";
export type {
  ProjectScopeOptions,
  WorkItemReadBucket,
  WorkItemsReadOptions,
} from "./scope";
