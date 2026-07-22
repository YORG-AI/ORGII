/**
 * Project store API.
 *
 * Slug-keyed wrappers around the `project_*` Tauri commands backed by
 * `~/.orgii/projects/projects.db`. The single source of truth for
 * frontend project / work-item data access.
 *
 * @example
 * ```typescript
 * import { projectApi } from "@src/api/http/project";
 *
 * const projects = await projectApi.readProjects();
 * const view = await projectApi.readWorkItemsViewData(slug);
 * ```
 */
import * as client from "./client";

export * from "./types";
export type {
  AdapterAuthMethod,
  AdapterDescriptor,
  OAuthDeviceFlow,
  OAuthFlowKind,
  OAuthFlowStart,
  OAuthRedirectFlow,
  SyncStatusReport,
} from "./sync";
export { OAUTH_FLOW_KIND, projectSyncApi } from "./sync";

export {
  buildLabelMap,
  buildMemberMap,
  enrichedWorkItemToUI,
  projectDataToUI,
  standaloneWorkItemDataToEnriched,
  uiWorkItemToFrontmatter,
  workItemDataToUI,
} from "./adapters";

export { invalidateCache as invalidateProjectCache } from "./cache";

export { client as projectClient };

export const projectApi = {
  // Init
  personalWorkspace: client.personalWorkspace,
  // Orgs
  readOrgs: client.readOrgs,
  createOrg: client.createOrg,
  deleteOrg: client.deleteOrg,
  configureOrgGitFolderSync: client.configureOrgGitFolderSync,
  syncOrgGitFolder: client.syncOrgGitFolder,
  resolveOrgGitFolderConflict: client.resolveOrgGitFolderConflict,
  // Collab sync bridge (design §16.8)
  configureOrgCollabSync: client.configureOrgCollabSync,
  collabLeaveCleanup: client.collabLeaveCleanup,
  drainCollabOutbox: client.drainCollabOutbox,
  listCollabOutboxPendingIds: client.listCollabOutboxPendingIds,
  ackCollabOutbox: client.ackCollabOutbox,
  applyCollabRemote: client.applyCollabRemote,
  // Projects
  readProjects: client.readProjects,
  readProject: client.readProject,
  writeProject: client.writeProject,
  deleteProject: client.deleteProject,
  // Labels
  readLabels: client.readLabels,
  writeLabels: client.writeLabels,
  // Milestones
  readMilestones: client.readMilestones,
  writeMilestones: client.writeMilestones,
  // Members
  readMembers: client.readMembers,
  writeMembers: client.writeMembers,
  // Work items
  readWorkItem: client.readWorkItem,
  readStandaloneWorkItem: client.readStandaloneWorkItem,
  readStandaloneWorkItems: client.readStandaloneWorkItems,
  readWorkItems: client.readWorkItems,
  readWorkItemsEnriched: client.readWorkItemsEnriched,
  readWorkItemsViewData: client.readWorkItemsViewData,
  writeWorkItem: client.writeWorkItem,
  writeStandaloneWorkItem: client.writeStandaloneWorkItem,
  deleteWorkItem: client.deleteWorkItem,
  restoreWorkItem: client.restoreWorkItem,
  purgeExpiredDeletedWorkItems: client.purgeExpiredDeletedWorkItems,
  updateWorkItemPartial: client.updateWorkItemPartial,
  moveWorkItem: client.moveWorkItem,
  allocateWorkItemId: client.allocateWorkItemId,
  allocateStandaloneWorkItemId: client.allocateStandaloneWorkItemId,
  // Routines
  listRoutines: client.listRoutines,
  readRoutine: client.readRoutine,
  upsertRoutine: client.upsertRoutine,
  deleteRoutine: client.deleteRoutine,
  listRoutineFires: client.listRoutineFires,
  fireRoutine: client.fireRoutine,
  // Batch
  batchDeleteWorkItems: client.batchDeleteWorkItems,
  batchUpdateWorkItems: client.batchUpdateWorkItems,
  // Assets
  saveAsset: client.saveAsset,
  deleteAsset: client.deleteAsset,
  listAssets: client.listAssets,
  resolveAssetPath: client.resolveAssetPath,
};

export default projectApi;
