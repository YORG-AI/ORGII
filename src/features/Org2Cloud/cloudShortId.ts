/**
 * Managed-cloud work item short-id allocation (cloud-parity Phase B port of
 * the collabShortId server path; Phase E made it the single entry point).
 *
 * Under a CLOUD-aliased org the per-project counter lives on the server
 * (`cloud_allocate_work_item_short_id`) so two members can never mint the
 * same `PREFIX-n`. EVERY work-item creation path must allocate through
 * `allocateCloudAwareWorkItemId` — calling `projectApi.allocateWorkItemId`
 * directly under a cloud-synced org reintroduces the short-id collision
 * that merges two members' distinct work items. A `null` server result
 * falls through to the local counter (the documented offline /
 * missing-credential residual: a locally allocated id can collide with
 * another member's offline allocation and the OCC push merges the rows
 * instead of renaming).
 */
import { projectApi } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import { resolveCloudOrgForProjectOrg } from "./org2CloudProjectOrgAlias";
import { allocateWorkItemShortId } from "./org2CloudProjectsClient";

const logger = createLogger("cloudShortId");

/**
 * Signed-in fresh JWT for imperative (non-hook) cloud calls, or null when
 * signed out / the refresh failed. A refreshed session is written back to
 * the auth atom (same idiom as the sync engine's pass).
 */
export async function getFreshCloudAccessToken(): Promise<string | null> {
  const store = getInstrumentedStore();
  const current = store.get(org2CloudAuthAtom);
  if (!current) return null;
  const fresh = await ensureFreshSession(current);
  if (!fresh) return null;
  commitRefreshedAuth(
    (updater) => store.set(org2CloudAuthAtom, updater),
    current,
    fresh
  );
  return fresh.accessToken;
}

/**
 * Server allocation for a project under a CLOUD-aliased org. Returns the
 * allocated short id, or null when the project org is not cloud-aliased
 * (caller proceeds with its self-hosted / local path) or the allocation
 * cannot run (signed out, server unreachable, project not pushed yet) —
 * the logged fallback residual documented on the module.
 */
export async function tryAllocateCloudWorkItemShortId(
  projectOrgId: string,
  projectId: string
): Promise<string | null> {
  const cloudOrgId = await resolveCloudOrgForProjectOrg(projectOrgId);
  if (!cloudOrgId) return null;
  const accessToken = await getFreshCloudAccessToken();
  if (!accessToken) {
    logger.warn(
      `cloud org ${cloudOrgId} has no usable session; allocating project ${projectId} short id locally`
    );
    return null;
  }
  try {
    const allocated = await allocateWorkItemShortId(
      accessToken,
      cloudOrgId,
      projectId
    );
    return allocated.shortId;
  } catch (error) {
    // Server unreachable / project not pushed yet: the documented offline
    // residual — the local id can collide and be merged by the OCC push.
    logger.warn(
      `cloud short-id allocation failed for project ${projectId}; falling back to the local counter`,
      error
    );
    return null;
  }
}

/**
 * THE work-item short-id entry point for project-scoped creation paths:
 * resolve the owning project org, try the cloud allocator for cloud-aliased
 * orgs, and fall back to the local counter otherwise (purely local org,
 * signed out, or server unreachable — the logged residual above).
 */
export async function allocateCloudAwareWorkItemId(
  projectSlug: string
): Promise<string> {
  try {
    const project = await projectApi.readProject(projectSlug);
    const cloudShortId = await tryAllocateCloudWorkItemShortId(
      project.meta.org_id,
      project.meta.id
    );
    if (cloudShortId) return cloudShortId;
  } catch (error) {
    // readProject failed: we cannot even resolve the owning org, so the
    // local counter is the only option left.
    logger.warn(
      `could not resolve owning org for ${projectSlug}; falling back to the local counter`,
      error
    );
  }
  return projectApi.allocateWorkItemId(projectSlug);
}

/**
 * Standalone (project-less) counterpart of `allocateCloudAwareWorkItemId`.
 *
 * The server allocator is strictly per-project — it bumps
 * `cloud_projects.next_work_item_id` and raises `ORG2_CONFLICT` when no
 * project row matches — so a standalone work item can NEVER allocate on the
 * server today. The best available source is the org-scoped LOCAL counter
 * (Rust `allocate_standalone_short_id`): it scans the org's existing
 * standalone items — including rows synced in from teammates — and hands
 * out max+1.
 *
 * Residual (same class as the offline residual documented on the module):
 * two members creating standalone items under the same cloud org inside one
 * pull interval can mint the same `WI-n`; the OCC push then merges the two
 * rows instead of renaming. Removing it needs a server-side standalone
 * allocator (per-org counter RPC) — this helper is the single upgrade point
 * when that lands.
 *
 * `orgId` is the PROJECT-org id of the surface the creation happens in;
 * omit it for a true personal item and the Rust side defaults to
 * `personal-org`.
 */
export async function allocateCloudAwareStandaloneWorkItemId(
  orgId?: string | null
): Promise<string> {
  return projectApi.allocateStandaloneWorkItemId(orgId ? { orgId } : undefined);
}
