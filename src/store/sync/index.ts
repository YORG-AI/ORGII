/**
 * Shared sync-state atoms (Phase 4.6 Track B).
 *
 * Lives at `src/store/sync/` (not module-local) because the atoms are
 * consumed by 2+ modules — the project settings panel and the status
 * bar — per `src/store/store-organization.md`.
 */
export {
  projectSyncStatusAtom,
  useSyncStatusBridge,
} from "./projectSyncStatusAtom";
export { syncDeepLinkAtom } from "./syncDeepLinkAtom";
