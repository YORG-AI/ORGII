import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";

import { projectApi } from "@src/api/http/project";
import type { ProjectOrg } from "@src/api/http/project";
import { useProjectDataChanged } from "@src/hooks/project";

import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import {
  type Org2CloudOrg,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "./org2CloudOrgsAtom";

const ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Resolve whether the signed-in user may perform org-admin operations on a
 * project's local org. Cloud projects store a durable local-org alias whose
 * `external_org_id` points at the managed-cloud org, while the user's role is
 * held by the live cloud roster. Local and self-hosted project orgs remain
 * unrestricted by this cloud-only gate.
 */
export function canAdministerProjectOrg(
  projectOrgId: string | undefined,
  projectOrgs: readonly ProjectOrg[],
  cloudOrgs: readonly Org2CloudOrg[],
  options: {
    projectOrgsLoaded: boolean;
    cloudRosterPending: boolean;
  }
): boolean {
  if (!projectOrgId) return true;

  const directCloudOrg = cloudOrgs.find((org) => org.orgId === projectOrgId);
  if (directCloudOrg) return ADMIN_ROLES.has(directCloudOrg.role);

  // Until the local alias table is known, treating an unknown org as local
  // would briefly expose destructive controls for a cloud member.
  if (!options.projectOrgsLoaded) return false;

  const projectOrg = projectOrgs.find((org) => org.id === projectOrgId);
  const cloudOrg = projectOrg?.external_org_id
    ? cloudOrgs.find((org) => org.orgId === projectOrg.external_org_id)
    : undefined;
  if (cloudOrg) return ADMIN_ROLES.has(cloudOrg.role);

  // A signed-in user's cloud roster is authoritative only after its first
  // successful load. A marked alias may therefore still be cloud-backed
  // while the roster is pending; fail closed until that ambiguity clears.
  if (
    options.cloudRosterPending &&
    projectOrg?.sync_provider === "orgii_collab" &&
    Boolean(projectOrg.external_org_id)
  ) {
    return false;
  }

  return true;
}

export function useProjectOrgCloudPermissions(): {
  canAdminister: (projectOrgId: string | undefined) => boolean;
} {
  const auth = useAtomValue(org2CloudAuthAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const cloudOrgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
  const [projectOrgsLoaded, setProjectOrgsLoaded] = useState(false);

  const refreshProjectOrgs = useCallback(async () => {
    try {
      setProjectOrgs(await projectApi.readOrgs());
      setProjectOrgsLoaded(true);
    } catch {
      // Preserve the previous authoritative snapshot. On first-load failure
      // the gate remains closed rather than guessing that an org is local.
    }
  }, []);

  useProjectDataChanged(refreshProjectOrgs, { fireOnMount: true });

  const canAdminister = useCallback(
    (projectOrgId: string | undefined) =>
      canAdministerProjectOrg(projectOrgId, projectOrgs, cloudOrgs, {
        projectOrgsLoaded,
        cloudRosterPending: Boolean(auth) && !cloudOrgsLoaded,
      }),
    [auth, cloudOrgs, cloudOrgsLoaded, projectOrgs, projectOrgsLoaded]
  );

  return { canAdminister };
}
