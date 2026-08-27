/**
 * Collab sync bridge (design §16.8) — outbox drain/ack and remote apply for
 * project orgs backed by the orgii collab plane.
 */
import { invoke } from "@tauri-apps/api/core";

import { invalidateCache } from "../cache";
import type {
  CollabOutboxAckResult,
  CollabOutboxPushItem,
  CollabPendingEntity,
  CollabRemoteEntity,
  ProjectOrg,
} from "../types";

/**
 * Mark a local project org as backed by the orgii collab plane
 * (`source='collab'`, `sync_provider='orgii_collab'`). Local mutations
 * under the org start enqueueing orgii_collab outbox rows from here on.
 */
export async function configureOrgCollabSync(input: {
  orgId: string;
  externalOrgId?: string;
}): Promise<ProjectOrg> {
  const result = await invoke<ProjectOrg>("project_configure_org_collab_sync", {
    orgId: input.orgId,
    externalOrgId: input.externalOrgId ?? null,
  });
  invalidateCache("__project_orgs__");
  return result;
}

/**
 * Leave-org cleanup for a collab-aliased project org: purge every
 * orgii_collab outbox row for the org (worker rows are untouched) and
 * reverse the marking `configureOrgCollabSync` applied, in one Rust
 * transaction. Without it, the scrub's project deletions leave DELETE
 * tombstones that would drain on a later rejoin and destroy the org's
 * shared projects for everyone. Leaves the org row and its projects
 * alone — the leave flow owns the project purge.
 */
export async function collabLeaveCleanup(orgId: string): Promise<{
  deletedOutboxRows: number;
  orgUnmarked: boolean;
}> {
  const result = await invoke<{
    deletedOutboxRows: number;
    orgUnmarked: boolean;
  }>("project_collab_leave_cleanup", { orgId });
  invalidateCache("__project_orgs__");
  return result;
}

/** Claim + hydrate pending collab pushes for one local project org. */
export async function drainCollabOutbox(input: {
  orgId: string;
  max?: number;
}): Promise<CollabOutboxPushItem[]> {
  return invoke("project_collab_outbox_drain", {
    orgId: input.orgId,
    max: input.max ?? null,
  });
}

export async function listCollabOutboxPendingIds(
  orgId: string
): Promise<CollabPendingEntity[]> {
  return invoke("project_collab_outbox_pending_ids", { orgId });
}

/** Persist collab push outcomes (success / conflict-requeue / backoff). */
export async function ackCollabOutbox(
  results: CollabOutboxAckResult[]
): Promise<void> {
  return invoke("project_collab_outbox_ack", { results });
}

/**
 * Apply pulled server rows into the local store (per-field merged,
 * echo-free). Returns how many entities changed local state.
 */
export async function applyCollabRemote(input: {
  orgId: string;
  orgName?: string;
  entities: CollabRemoteEntity[];
}): Promise<number> {
  const applied = await invoke<number>("project_collab_apply_remote", {
    orgId: input.orgId,
    orgName: input.orgName ?? null,
    entities: input.entities,
  });
  if (applied > 0) {
    invalidateCache();
  }
  return applied;
}
