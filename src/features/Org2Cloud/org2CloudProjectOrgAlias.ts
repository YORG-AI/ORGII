/**
 * Local project-org aliasing for managed-cloud orgs (cloud-parity Phase B).
 *
 * The Rust collab bridge is backend-agnostic: any local `project_orgs` row
 * with `sync_provider='orgii_collab'` routes its project / work-item
 * mutations into the orgii_collab outbox, and `external_org_id` records
 * which REMOTE org drains it. Cloud orgs reuse that exact flag (the TS
 * engine decides which backend the outbox pushes to), so the alias row is
 * the single durable link between a cloud org and its local project data —
 * `org2CloudOrgsAtom` is in-memory only and cannot carry it.
 *
 * `ensureProjectOrgForCloudOrg` mirrors the self-hosted
 * `ensureProjectOrgForCollabOrg` (CollabOrgForm) semantics, with one
 * cross-plane guard: a name-matched org is only adopted when it carries NO
 * collab marking at all — neither an `external_org_id` (aliased to a
 * different org) nor `sync_provider='orgii_collab'` without one (a legacy
 * stamp-less self-hosted alias: the Rust pull-path heal sets only the
 * provider flag). Stealing either would drain one outbox into two backends.
 * Conversely, a row WE own (external-id or id match) that is marked but
 * missing `external_org_id` is re-stamped, or `resolveCloudOrgForProjectOrg`
 * could never find it and the cloud plane would sync rows it cannot
 * arbitrate locks / allocate short ids for.
 */
import { projectApi } from "@src/api/http/project";
import type { ProjectOrg } from "@src/api/http/project";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import {
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "./org2CloudOrgsAtom";

/** The provider flag the Rust outbox routing keys on (design §16.2/§16.8). */
export const COLLAB_SYNC_PROVIDER = "orgii_collab";

export interface CloudOrgAliasInput {
  orgId: string;
  name: string;
}

/**
 * Ensure a local project org aliased to the cloud org exists and carries
 * the collab-sync marking. Called on cloud org create/join completion and
 * self-healed by the sync engine once per start (covers orgs that predate
 * Phase B). Idempotent: an already-marked alias is returned unchanged.
 */
export async function ensureProjectOrgForCloudOrg(
  org: CloudOrgAliasInput
): Promise<ProjectOrg> {
  const projectOrgs = await projectApi.readOrgs();
  const projectOrg =
    projectOrgs.find((candidate) => candidate.external_org_id === org.orgId) ??
    projectOrgs.find((candidate) => candidate.id === org.orgId) ??
    projectOrgs.find(
      (candidate) =>
        candidate.name === org.name &&
        !candidate.external_org_id &&
        // Cross-plane guard: a marked row WITHOUT an external_org_id is a
        // legacy stamp-less alias of the SELF-HOSTED plane (the Rust heal
        // never stamps the id) — adopting it by name would drain its outbox
        // into two backends.
        candidate.sync_provider !== COLLAB_SYNC_PROVIDER
    ) ??
    (await projectApi.createOrg({ name: org.name, id: org.orgId }));

  // Mark the aliased local org as collab-synced: this is what routes local
  // project / work-item mutations into the orgii_collab outbox. The
  // engine's apply path self-heals the flag too, but stamping it here makes
  // the very first local mutation sync without waiting for a pull. A row
  // already marked but missing `external_org_id` (id-matched legacy alias
  // healed by the Rust pull path, which sets only the provider flag) is
  // re-stamped: without the id, `resolveCloudOrgForProjectOrg` returns null
  // and the lock/short-id planes silently never engage.
  if (
    projectOrg.sync_provider !== COLLAB_SYNC_PROVIDER ||
    !projectOrg.external_org_id
  ) {
    return projectApi.configureOrgCollabSync({
      orgId: projectOrg.id,
      externalOrgId: org.orgId,
    });
  }
  return projectOrg;
}

/**
 * Resolve the cloud org backing a local project org, or null when the
 * project org is not cloud-aliased. A self-hosted alias also carries
 * `sync_provider='orgii_collab'` but its `external_org_id` is a self-hosted
 * org id — never present in `org2CloudOrgsAtom` — so the membership check
 * keeps the two planes apart. Also null while signed out (the orgs atom is
 * cleared), which callers treat like the missing-credential residual.
 */
export async function resolveCloudOrgForProjectOrg(
  projectOrgId: string
): Promise<string | null> {
  const projectOrgs = await projectApi.readOrgs();
  const projectOrg = projectOrgs.find(
    (candidate) => candidate.id === projectOrgId
  );
  if (!projectOrg || projectOrg.sync_provider !== COLLAB_SYNC_PROVIDER) {
    return null;
  }
  const externalOrgId = projectOrg.external_org_id;
  if (!externalOrgId) return null;
  const cloudOrgs = getInstrumentedStore().get(org2CloudOrgsAtom);
  return cloudOrgs.some((org) => org.orgId === externalOrgId)
    ? externalOrgId
    : null;
}

/**
 * Whether a project org's cloud membership cannot yet be PROVEN because the
 * signed-in user's cloud org roster (`org2CloudOrgsAtom`) has not completed
 * its first successful `list_my_orgs` load. This is the "signed in but roster
 * not yet known" state — distinct from "definitively not a cloud org"
 * (unmarked, or the roster loaded and the alias absent, i.e. a self-hosted
 * alias). During it a `resolveCloudOrgForProjectOrg` null is indistinguishable
 * from a genuinely cloud-aliased org, so a caller that arbitrates cross-member
 * locks must treat pending like an unresolved membership and block rather than
 * proceed without server arbitration.
 *
 * Signed out is never pending (the roster is legitimately empty — the
 * documented proceed-locally residual); nor is a loaded-but-empty roster (a
 * self-hosted-only user), so this false-blocks neither.
 */
export async function isCloudOrgMembershipPending(
  projectOrgId: string
): Promise<boolean> {
  const store = getInstrumentedStore();
  if (!store.get(org2CloudAuthAtom)) return false;
  if (store.get(org2CloudOrgsLoadedAtom)) return false;
  const projectOrgs = await projectApi.readOrgs();
  const projectOrg = projectOrgs.find(
    (candidate) => candidate.id === projectOrgId
  );
  return (
    projectOrg?.sync_provider === COLLAB_SYNC_PROVIDER &&
    Boolean(projectOrg.external_org_id)
  );
}
