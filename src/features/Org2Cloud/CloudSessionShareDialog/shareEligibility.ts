/**
 * Pure eligibility rule for the cloud share dialog (migration 0012): which
 * cloud orgs can one of the owner's sessions be shared under?
 *
 * A repo scope is only the governance boundary; it is NOT ownership. The
 * session must also explicitly belong to the org, either because it was
 * created under that cloud org (`Session.orgId`) or because the user tagged
 * it into the org. This mirrors `Org2CloudSyncEngine.syncAllOrgs` and prevents
 * a Personal session from exposing every org that happens to configure the
 * same Git remote.
 *
 * React/Jotai-free by design — unit-testable in isolation.
 */
import { peekMatchingOrgRepoScope } from "@src/features/TeamCollaboration/repoScopeResolver";
import {
  type SessionOrgTags,
  cloudOrgIdsForSession,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  type Org2CloudOrg,
  parseCloudOrgSelectorValue,
} from "../org2CloudOrgsAtom";

export function getCloudShareOrgsForSession(
  session: Pick<Session, "session_id" | "orgId">,
  sessionOrgTags: SessionOrgTags,
  cloudOrgs: Org2CloudOrg[],
  repoScopesByOrg: Record<string, string[]>,
  /** Resolved remote scope keys; null = no remote, undefined = resolving. */
  scopeKeys: string[] | null | undefined
): Org2CloudOrg[] {
  const explicitOrgIds = new Set(
    cloudOrgIdsForSession(sessionOrgTags, session.session_id)
  );
  const owningCloudOrgId = session.orgId
    ? parseCloudOrgSelectorValue(session.orgId)
    : null;
  if (owningCloudOrgId) explicitOrgIds.add(owningCloudOrgId);

  return cloudOrgs.filter((org) => {
    if (!explicitOrgIds.has(org.orgId)) return false;
    const matched = peekMatchingOrgRepoScope(
      scopeKeys,
      repoScopesByOrg[org.orgId]
    );
    return matched !== null && matched !== undefined;
  });
}

/**
 * User-facing share sections are scoped to the org selected in the sidebar.
 * Personal means no cloud share affordance, even when a session retains an
 * explicit cloud tag; selecting a cloud org exposes only that org's roster.
 */
export function getActiveCloudShareOrgsForSession(
  activeCloudOrgId: string | null,
  session: Pick<Session, "session_id" | "orgId">,
  sessionOrgTags: SessionOrgTags,
  cloudOrgs: Org2CloudOrg[],
  repoScopesByOrg: Record<string, string[]>,
  scopeKeys: string[] | null | undefined
): Org2CloudOrg[] {
  if (!activeCloudOrgId) return [];
  return getCloudShareOrgsForSession(
    session,
    sessionOrgTags,
    cloudOrgs,
    repoScopesByOrg,
    scopeKeys
  ).filter((org) => org.orgId === activeCloudOrgId);
}
