/** Auto-tag a freshly launched session into the sidebar's active cloud org scope. */
import {
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import { org2CloudSyncEngine } from "@src/features/Org2Cloud/org2CloudSyncEngine";
import { createLogger } from "@src/hooks/logger";
import { DEFAULT_SESSION_ORG_ID } from "@src/store/session/creatorStateAtom";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import { pickMatchingOrgScope } from "./collabSyncUtils";
import { resolveShareableScopeKeys } from "./repoScopeResolver";
import {
  cloudOrgToken,
  sessionOrgTagsAtom,
  withTag,
} from "./sessionOrgTagsAtom";

const log = createLogger("autoTagNewSession");

export interface AutoTagLaunchedSessionInput {
  sessionId: string;
  repoPath: string | null;
  launchOrgId: string | null;
}

export async function autoTagLaunchedSessionToActiveCloudOrg({
  sessionId,
  repoPath,
  launchOrgId,
}: AutoTagLaunchedSessionInput): Promise<boolean> {
  if (launchOrgId && launchOrgId !== DEFAULT_SESSION_ORG_ID) return false;
  if (!repoPath) return false;
  if (!isStoreInitialized()) return false;

  const store = getInstrumentedStore();
  const orgId = store.get(sidebarActiveCloudOrgIdAtom);
  if (!orgId) return false;
  if (!store.get(org2CloudOrgsAtom).some((org) => org.orgId === orgId)) {
    return false;
  }

  const scopeKeys = await resolveShareableScopeKeys(repoPath);
  const orgScopes = store.get(org2CloudRepoScopesAtom)[orgId];
  if (pickMatchingOrgScope(scopeKeys, orgScopes) === null) return false;

  store.set(sessionOrgTagsAtom, (current) =>
    withTag(current, sessionId, cloudOrgToken(orgId))
  );
  void org2CloudSyncEngine.runSyncPassAndWaitForDrain().catch((error) => {
    log.warn("auto-tag sync pass failed; next pass will retry", error);
  });
  return true;
}
