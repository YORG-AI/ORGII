import { atomWithStorage } from "jotai/utils";

import { DEFAULT_SESSION_ORG_ID } from "@src/store/session/creatorStateAtom";

export const SIDEBAR_SELECTED_ORG_ID_STORAGE_KEY =
  "orgii:sidebar-selected-org-id:v1";

/**
 * Shared organization scope for every sidebar and work-management surface.
 *
 * Read synchronously so the persisted organization is restored before the
 * first render on both a cold app start and a frontend hot reload.
 */
export const sidebarSelectedOrgIdAtom = atomWithStorage<string>(
  SIDEBAR_SELECTED_ORG_ID_STORAGE_KEY,
  DEFAULT_SESSION_ORG_ID,
  undefined,
  { getOnInit: true }
);
sidebarSelectedOrgIdAtom.debugLabel = "sidebarSelectedOrgIdAtom";
