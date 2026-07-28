import type { Org2CloudOrg } from "./org2CloudOrgsAtom";

/**
 * Org-wide Realtime planes are demand-driven: no socket is held for a local
 * or personal scope; membership, data, and presence channels are joined only
 * for the cloud org the workspace is actively using. The subscription
 * true-edge performs the compensating roster read when that scope is opened.
 */
export function resolveActiveRealtimeOrgId(
  cloudOrgs: readonly Pick<Org2CloudOrg, "orgId">[],
  sidebarOrgId: string | null,
  managementOrgId: string | null = null
): string | null {
  // The visible management surface is the strongest demand signal. Creating
  // or opening an org panel does not implicitly mutate the sidebar filter,
  // but its roster/policy UI still needs that org's live invalidations.
  const requestedOrgId = managementOrgId ?? sidebarOrgId;
  if (!requestedOrgId) return null;
  return cloudOrgs.some((org) => org.orgId === requestedOrgId)
    ? requestedOrgId
    : null;
}
