/**
 * Managed-cloud work item execution lock (cloud-parity Phase B port of the
 * collabWorkItemLock server path).
 *
 * Under a CLOUD-aliased org the execution lock is arbitrated by the server
 * (`cloud_acquire_work_item_lock` / `cloud_release_work_item_lock`) so two
 * members can never start an agent on the same work item at once. The lock
 * lives at `payload.executionLock` and syncs down into every member's local
 * work-item row through the projects channel (server-owned: the upsert path
 * preserves the stored lock over whatever a client sends).
 *
 * Resolution mirrors `cloudShortId.ts`:
 *   1. project org → cloud org via the durable alias
 *      (`resolveCloudOrgForProjectOrg`);
 *   2. server acquire/release with the account JWT;
 *   3. not cloud-aliased / signed out ⇒ `false` — the caller falls through
 *      to its self-hosted / local path.
 *
 * `acquireCloudWorkItemLock` throws on `ORG2_CONFLICT` (matched by the
 * generalized `isCollabConflictError`) so the orchestrator can refresh +
 * surface the holder instead of double-starting.
 */
import { projectApi } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";

import { getFreshCloudAccessToken } from "./cloudShortId";
import { resolveCloudOrgForProjectOrg } from "./org2CloudProjectOrgAlias";
import {
  acquireWorkItemLock,
  releaseWorkItemLock,
} from "./org2CloudProjectsClient";

const logger = createLogger("cloudWorkItemLock");

interface ResolvedCloudWorkItem {
  cloudOrgId: string;
  accessToken: string;
}

/**
 * Resolve the cloud org + fresh JWT for a work item, or null when the work
 * item is not under a cloud-aliased org (or the user is signed out — the
 * same proceed-without-arbitration residual as the self-hosted
 * missing-credential case, logged, never silent).
 */
async function resolveCloudWorkItem(
  projectSlug: string
): Promise<ResolvedCloudWorkItem | null> {
  const project = await projectApi.readProject(projectSlug);
  const cloudOrgId = await resolveCloudOrgForProjectOrg(project.meta.org_id);
  if (!cloudOrgId) return null;
  const accessToken = await getFreshCloudAccessToken();
  if (!accessToken) {
    logger.warn(
      `cloud org ${cloudOrgId} has no usable session; skipping server lock for ${projectSlug}`
    );
    return null;
  }
  return { cloudOrgId, accessToken };
}

/**
 * Acquire the cloud execution lock before starting an agent. Resolves to
 * `false` when the work item is not cloud-aliased (the caller continues
 * with its self-hosted / local path). Rejects on `ORG2_CONFLICT` when
 * another member holds the lock. The server forces the holder identity;
 * only a hint travels in `lockPayload`.
 */
export async function acquireCloudWorkItemLock(
  projectSlug: string,
  workItemId: string,
  lockPayload: Record<string, unknown> = {}
): Promise<boolean> {
  const resolved = await resolveCloudWorkItem(projectSlug);
  if (!resolved) return false;
  await acquireWorkItemLock(
    resolved.accessToken,
    resolved.cloudOrgId,
    workItemId,
    lockPayload
  );
  return true;
}

/**
 * Release the cloud execution lock when a session terminates. Returns
 * whether a release RPC was issued; non-cloud work items are a no-op. RPC
 * failures propagate — the caller (`releaseCollabWorkItemLock`) already
 * swallows them best-effort.
 */
export async function releaseCloudWorkItemLock(
  projectSlug: string,
  workItemId: string
): Promise<boolean> {
  const resolved = await resolveCloudWorkItem(projectSlug);
  if (!resolved) return false;
  await releaseWorkItemLock(
    resolved.accessToken,
    resolved.cloudOrgId,
    workItemId
  );
  return true;
}
