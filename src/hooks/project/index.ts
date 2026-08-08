/**
 * Project store hooks.
 *
 * The sync / auto-sync / tracker-mode hooks are gone — they backed the
 * legacy file-based git-sync model that's been replaced by the global
 * SQLite project store. What remains is the data-changed event bus
 * and the project-list helpers that read from the new `projectApi`.
 */

export {
  useCurrentUserMemberIds,
  findMemberIdsByUser,
  findMemberByEmail,
  resetGitIdentityCache,
} from "./useCurrentUserMemberId";

export { useWorkItemImageInsert } from "./useWorkItemImageInsert";

export {
  useWorkItemCreatorDraft,
  workItemDraftToStubWorkItem,
  mapWorkItemUpdatesToDraftPatch,
  WORK_ITEM_CREATOR_DRAFT_ID,
} from "./useWorkItemCreatorDraft";
export type {
  UseWorkItemCreatorDraftOptions,
  UseWorkItemCreatorDraftReturn,
} from "./useWorkItemCreatorDraft";

export {
  useProjectDataChangedListener,
  useProjectDataChanged,
  projectDataChangedSignalAtom,
  projectDataChangedRepoPathAtom,
  projectDataChangedChangeAtom,
  type ProjectDataChange,
} from "./useProjectDataChanged";

export { useAllRepoProjects } from "./useAllRepoProjects";
export type { UseAllRepoProjectsReturn } from "./useAllRepoProjects";
