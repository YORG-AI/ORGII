import { atom } from "jotai";

import { DEFAULT_SESSION_ORG_ID } from "@src/store/session/creatorStateAtom";

/** Shared organization scope for every sidebar and work-management surface. */
export const sidebarSelectedOrgIdAtom = atom<string>(DEFAULT_SESSION_ORG_ID);
sidebarSelectedOrgIdAtom.debugLabel = "sidebarSelectedOrgIdAtom";
