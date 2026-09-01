/**
 * Domain Adapters
 *
 * Shared item builders for converting domain objects into SpotlightItem arrays.
 * Eliminates duplication across selectors and the main spotlight.
 */
export {
  buildRepoSpotlightItems,
  sortRepoItemsSelectedFirst,
} from "./repoAdapter";
export { isSystemPathRepoItem } from "@src/features/SessionCreator/utils/systemPathSource";
export { buildBranchSpotlightItems } from "./branchAdapter";
