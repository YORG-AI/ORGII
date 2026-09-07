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
} from "./useCurrentUserMemberId";

export { useWorkItemImageInsert } from "./useWorkItemImageInsert";

export {
  useWorkItemCreatorDraft,
  workItemDraftToStubWorkItem,
  mapWorkItemUpdatesToDraftPatch,
} from "./useWorkItemCreatorDraft";

export {
  useProjectDataChangedListener,
  useProjectDataChanged,
  projectDataChangedSignalAtom,
} from "./useProjectDataChanged";

export { useAllRepoProjects } from "./useAllRepoProjects";

export { useProjectCachedResource } from "./useProjectCachedResource";
