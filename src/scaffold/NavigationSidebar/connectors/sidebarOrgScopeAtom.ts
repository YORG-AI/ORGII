/** Shared organization scope for every mounted workstation-sidebar surface. */
import { atom } from "jotai";

import { DEFAULT_SESSION_ORG_ID } from "@src/store/session/creatorStateAtom";

/**
 * The fixed and floating sidebars can be mounted at the same time. Their
 * scope must therefore live above either connector instance; component-local
 * state lets the hidden sidebar overwrite cloud privacy and session filters.
 */
export const sidebarSelectedOrgIdAtom = atom<string>(DEFAULT_SESSION_ORG_ID);
sidebarSelectedOrgIdAtom.debugLabel = "sidebarSelectedOrgIdAtom";
