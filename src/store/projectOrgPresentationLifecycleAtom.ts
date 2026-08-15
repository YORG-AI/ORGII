import { atom } from "jotai";

import { closeProjectOrgChatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabLifecycleAtoms";
import { closeProjectOrgWorkStationTabsAtom } from "@src/store/workstation/tabRegistry/atoms";

/** Remove a deleted/revoked project org from every rendered tab surface. */
export const invalidateProjectOrgPresentationAtom = atom(
  null,
  (_get, set, orgIdOrIds: string | readonly string[]) => {
    const orgIds =
      typeof orgIdOrIds === "string" ? [orgIdOrIds] : [...orgIdOrIds];
    if (orgIds.length === 0) return;
    set(closeProjectOrgChatPanelTabsAtom, orgIds);
    for (const orgId of orgIds) {
      set(closeProjectOrgWorkStationTabsAtom, orgId);
    }
  }
);
invalidateProjectOrgPresentationAtom.debugLabel =
  "invalidateProjectOrgPresentationAtom";
