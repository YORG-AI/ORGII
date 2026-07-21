import type { ProjectOrg } from "@src/api/http/project";
import type { Org2CloudOrg } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { COLLAB_SYNC_PROVIDER } from "@src/features/Org2Cloud/org2CloudProjectOrgAlias";

/**
 * Local project-org rows are durable mirrors, not an authorization source.
 * A managed-cloud alias can therefore outlive the user's membership (or the
 * remote org itself). Only expose such aliases while the authoritative cloud
 * roster still contains their remote org id. Plain local orgs and legacy
 * self-hosted aliases without an external id keep their local semantics.
 */
export function filterSelectableProjectOrgs(
  projectOrgs: readonly ProjectOrg[],
  cloudOrgs: readonly Org2CloudOrg[]
): ProjectOrg[] {
  const liveCloudOrgIds = new Set(cloudOrgs.map((org) => org.orgId));
  return projectOrgs.filter(
    (org) =>
      org.sync_provider !== COLLAB_SYNC_PROVIDER ||
      !org.external_org_id ||
      liveCloudOrgIds.has(org.external_org_id)
  );
}
