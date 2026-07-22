/**
 * Managed-cloud projects/work-items sync client (migration 0013, cloud-parity
 * Phase B).
 *
 * Typed throwing wrappers for the eight `org2_cloud` project/work-item RPCs,
 * in the `org2CloudSyncClient` idiom (raw fetch, JWT Bearer +
 * `Content-Profile: org2_cloud`, `ORG2_*` code extraction). The wire contract
 * (the 0013 SQL mirrors these exact names):
 *
 * - `cloud_upsert_project(p_org_id, project, base_version)` → `{id, version}`
 * - `cloud_upsert_work_item(p_org_id, work_item, base_version)` → `{id, version}`
 * - `cloud_delete_project(p_org_id, p_project_id)` (org admin, tombstone cascade)
 * - `cloud_delete_work_item(p_org_id, p_work_item_id)` (any member, idempotent)
 * - `cloud_allocate_work_item_short_id(p_org_id, p_project_id)` → `{shortId, n}`
 * - `cloud_acquire_work_item_lock(p_org_id, p_work_item_id, lock_payload)` →
 *   int version (the SQL parameter is `lock_payload`; the design's shorthand
 *   `lock` is a reserved SQL keyword)
 * - `cloud_release_work_item_lock(p_org_id, p_work_item_id)` → int version
 * - `cloud_list_org_collab_state(p_org_id, since)` →
 *   `{serverTime, projects, workItems}`
 *
 * Whole-row OCC everywhere: a base-version mismatch raises `ORG2_CONFLICT`,
 * which the shared `ProjectSyncChannel` dispatches through the generalized
 * `isCollabConflictError`. `createCloudProjectSyncClient` lifts these
 * wrappers into the channel's `CollabSyncBackendClient` slice so the
 * self-hosted channel + Rust bridge drive the cloud backend unchanged.
 */
import { z } from "zod/v4";

import type { ProjectSyncChannelDeps } from "../TeamCollaboration/engine/ProjectSyncChannel";
import type {
  AllocateWorkItemShortIdResult,
  CollabOrgState,
  CollabUpsertResult,
  DeleteProjectMetadataInput,
  DeleteWorkItemMetadataInput,
  ListOrgStateInput,
  UpsertProjectMetadataInput,
  UpsertWorkItemInput,
} from "../TeamCollaboration/sync/CollabSyncBackend";
import { ORG2_CLOUD_POSTGREST_SCHEMA, getCloudEndpoint } from "./config";
import { fetchWithTransportRetry } from "./org2CloudFetchRetry";

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export const ORG2_PROJECTS_ERROR_CODES = [
  // Whole-row OCC rejection, allocator on a missing/tombstoned project, and
  // an execution lock held by another member.
  "ORG2_CONFLICT",
  // Admin-only surfaces (0013 raises via assert_org_admin / the prefix
  // gate): project delete, post-creation work_item_prefix change.
  "ORG2_ADMIN_REQUIRED",
  // Lock release by a non-holder non-admin.
  "ORG2_FORBIDDEN",
  // Entitlement gate (same `sessionSyncEnabled` key as the session push).
  "ORG2_SYNC_DISABLED",
  "ORG2_AUTH_REQUIRED",
  "ORG2_MEMBER_REQUIRED",
  "ORG2_ORG_NOT_FOUND",
  "ORG2_NOT_FOUND",
  "ORG2_VALIDATION",
] as const;

export type Org2ProjectsErrorCode = (typeof ORG2_PROJECTS_ERROR_CODES)[number];

/** RPC failure carrying the server's error code when recognizable. */
export class Org2CloudProjectsError extends Error {
  readonly code: Org2ProjectsErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudProjectsError";
    this.status = status;
    // Whole-token match (org2CloudSharesClient precedent): a longer future
    // code that textually contains a listed one must never be mis-mapped.
    const tokens = message.match(/\bORG2_[A-Z_]+\b/g) ?? [];
    this.code =
      (tokens.find((token) =>
        (ORG2_PROJECTS_ERROR_CODES as readonly string[]).includes(token)
      ) as Org2ProjectsErrorCode | undefined) ?? null;
  }
}

export function isOrg2ProjectsErrorCode(
  error: unknown,
  code: Org2ProjectsErrorCode
): boolean {
  return error instanceof Org2CloudProjectsError && error.code === code;
}

// ---------------------------------------------------------------------------
// RPC plumbing (throwing variant of the org2CloudClient idiom)
// ---------------------------------------------------------------------------

async function callProjectsRpc(
  functionName: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const endpoint = getCloudEndpoint();
  const response = await fetchWithTransportRetry(
    `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: endpoint.anonKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
      },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : `org2_cloud rpc ${functionName} failed with ${response.status}`;
    throw new Org2CloudProjectsError(message, response.status);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/** Server acknowledgement of an OCC upsert (CollabUpsertResult shape). */
const CloudUpsertResultSchema = z.object({
  id: z.string(),
  version: z.number(),
});

/** Server-allocated short id (AllocateWorkItemShortIdResult shape). */
const CloudAllocatedShortIdSchema = z.object({
  shortId: z.string(),
  n: z.number(),
});

const CloudCollabRowSchema = z.record(z.string(), z.unknown());

const CloudOrgCollabStateSchema = z.object({
  serverTime: z.string().optional(),
  projects: z.array(CloudCollabRowSchema).default([]),
  workItems: z.array(CloudCollabRowSchema).default([]),
});

/** Projects/work-items delta: rows are `payload || {version, updatedBy…, deletedAt}`. */
export interface CloudOrgCollabState {
  serverTime?: string;
  projects: Array<Record<string, unknown>>;
  workItems: Array<Record<string, unknown>>;
}

/**
 * The shared channel (and the Rust apply path behind it) read the
 * self-hosted key `updatedByMemberId`; cloud rows carry `updatedByUserId`
 * (cloud member ids ARE cloud user ids, the convention since
 * `buildCloudSessionMetadata`). Alias it so `ProjectSyncChannel` consumes
 * cloud rows byte-compatibly with self-hosted ones.
 */
function toChannelRow(row: Record<string, unknown>): Record<string, unknown> {
  let channelRow = row;
  if (
    typeof row.updatedByUserId === "string" &&
    row.updatedByMemberId === undefined
  ) {
    channelRow = { ...channelRow, updatedByMemberId: row.updatedByUserId };
  }
  if (
    typeof row.updated_by_user_id === "string" &&
    channelRow.updatedByMemberId === undefined
  ) {
    channelRow = {
      ...channelRow,
      updatedByMemberId: row.updated_by_user_id,
    };
  }
  if (
    typeof row.deleted_at === "string" &&
    channelRow.deletedAt === undefined
  ) {
    channelRow = { ...channelRow, deletedAt: row.deleted_at };
  }
  return channelRow;
}

// ---------------------------------------------------------------------------
// The eight wrappers
// ---------------------------------------------------------------------------

export interface CloudUpsertProjectInput {
  orgId: string;
  /** Full wire snapshot (incl. `_fieldRevisions`), stored verbatim. */
  project: Record<string, unknown>;
  /** OCC base version; null ⇒ insert (server checks `coalesce(base,-1)`). */
  baseVersion: number | null;
}

/** Member: whole-row OCC project upsert; mismatch raises ORG2_CONFLICT. */
export async function upsertProject(
  accessToken: string,
  input: CloudUpsertProjectInput
): Promise<CollabUpsertResult> {
  const payload = await callProjectsRpc("cloud_upsert_project", accessToken, {
    p_org_id: input.orgId,
    project: input.project,
    base_version: input.baseVersion,
  });
  return CloudUpsertResultSchema.parse(payload);
}

export interface CloudUpsertWorkItemInput {
  orgId: string;
  workItem: Record<string, unknown>;
  baseVersion: number | null;
}

/**
 * Member: whole-row OCC work-item upsert. `executionLock` is server-owned
 * (updates keep the STORED lock, inserts strip it) and the owning project's
 * counter advances monotonically past the item's numeric suffix.
 */
export async function upsertWorkItem(
  accessToken: string,
  input: CloudUpsertWorkItemInput
): Promise<CollabUpsertResult> {
  const payload = await callProjectsRpc("cloud_upsert_work_item", accessToken, {
    p_org_id: input.orgId,
    work_item: input.workItem,
    base_version: input.baseVersion,
  });
  return CloudUpsertResultSchema.parse(payload);
}

/** Org admin: tombstone cascade (project + its work items in one delta). */
export async function deleteProject(
  accessToken: string,
  orgId: string,
  projectId: string
): Promise<void> {
  await callProjectsRpc("cloud_delete_project", accessToken, {
    p_org_id: orgId,
    p_project_id: projectId,
  });
}

/** Member: idempotent work-item tombstone. */
export async function deleteWorkItem(
  accessToken: string,
  orgId: string,
  workItemId: string
): Promise<void> {
  await callProjectsRpc("cloud_delete_work_item", accessToken, {
    p_org_id: orgId,
    p_work_item_id: workItemId,
  });
}

/**
 * Member: atomic per-project short-id allocation. Deliberately does NOT
 * bump the project's version/updated_at; a missing or tombstoned project
 * raises ORG2_CONFLICT (the caller falls back to a provisional local id).
 */
export async function allocateWorkItemShortId(
  accessToken: string,
  orgId: string,
  projectId: string
): Promise<AllocateWorkItemShortIdResult> {
  const payload = await callProjectsRpc(
    "cloud_allocate_work_item_short_id",
    accessToken,
    {
      p_org_id: orgId,
      p_project_id: projectId,
    }
  );
  return CloudAllocatedShortIdSchema.parse(payload);
}

/**
 * Member: execution-lock arbitration. Succeeds on free / self (heartbeat) /
 * stale (30-min TTL); raises ORG2_CONFLICT while another member holds it.
 * The server forces the holder identity; `lockPayload` is only a hint.
 * Returns the work-item row's new version.
 */
export async function acquireWorkItemLock(
  accessToken: string,
  orgId: string,
  workItemId: string,
  lockPayload: Record<string, unknown>
): Promise<number> {
  const payload = await callProjectsRpc(
    "cloud_acquire_work_item_lock",
    accessToken,
    {
      p_org_id: orgId,
      p_work_item_id: workItemId,
      lock_payload: lockPayload,
    }
  );
  return z.number().parse(payload);
}

/** Holder or admin: idempotent lock release; returns the row's new version. */
export async function releaseWorkItemLock(
  accessToken: string,
  orgId: string,
  workItemId: string
): Promise<number> {
  const payload = await callProjectsRpc(
    "cloud_release_work_item_lock",
    accessToken,
    {
      p_org_id: orgId,
      p_work_item_id: workItemId,
    }
  );
  return z.number().parse(payload);
}

/**
 * Member: projects/work-items delta (rows with `updated_at >= since`,
 * tombstones included, org-wide visibility). `serverTime` anchors the
 * engine's persisted cursor (2s overlap; consumers are idempotent).
 * Sessions/members stay out — they have their own listings.
 */
export async function listOrgCollabState(
  accessToken: string,
  orgId: string,
  since?: string
): Promise<CloudOrgCollabState> {
  const payload = await callProjectsRpc(
    "cloud_list_org_collab_state",
    accessToken,
    {
      p_org_id: orgId,
      since: since ?? null,
    }
  );
  const parsed = CloudOrgCollabStateSchema.parse(payload);
  return {
    serverTime: parsed.serverTime,
    projects: parsed.projects.map(toChannelRow),
    workItems: parsed.workItems.map(toChannelRow),
  };
}

// ---------------------------------------------------------------------------
// ProjectSyncChannel adapter
// ---------------------------------------------------------------------------

/**
 * Lift a projects/work-items delta into the shared `CollabOrgState` shape
 * the channel consumes (cloud sessions and members have their own listings
 * and stay out of this plane).
 */
export function toCollabOrgState(state: CloudOrgCollabState): CollabOrgState {
  return {
    serverTime: state.serverTime,
    projects: state.projects.map(toChannelRow),
    workItems: state.workItems.map(toChannelRow),
  };
}

/** RPC seam so the engine (and tests) inject fetch-free fakes. */
export interface CloudProjectsRpc {
  upsertProject: typeof upsertProject;
  upsertWorkItem: typeof upsertWorkItem;
  deleteProject: typeof deleteProject;
  deleteWorkItem: typeof deleteWorkItem;
  listOrgCollabState: typeof listOrgCollabState;
}

const defaultCloudProjectsRpc: CloudProjectsRpc = {
  upsertProject,
  upsertWorkItem,
  deleteProject,
  deleteWorkItem,
  listOrgCollabState,
};

/**
 * The `ProjectSyncChannel` backend slice over the cloud RPCs. The adapter
 * authenticates with the JWT captured here; inputs carry business data only.
 * `baseVersion` falls back to the payload's own `version` when omitted,
 * matching the shared `ProjectSyncChannel` contract.
 */
export function createCloudProjectSyncClient(
  accessToken: string,
  rpc: CloudProjectsRpc = defaultCloudProjectsRpc
): ProjectSyncChannelDeps["client"] {
  return {
    async upsertProjectMetadata(
      input: UpsertProjectMetadataInput
    ): Promise<CollabUpsertResult> {
      const projectVersion = input.project.version;
      return rpc.upsertProject(accessToken, {
        orgId: input.orgId,
        project: input.project,
        baseVersion:
          input.baseVersion ??
          (typeof projectVersion === "number" ? projectVersion : null),
      });
    },

    async upsertWorkItem(
      input: UpsertWorkItemInput
    ): Promise<CollabUpsertResult> {
      const workItemVersion = input.workItem.version;
      return rpc.upsertWorkItem(accessToken, {
        orgId: input.orgId,
        workItem: input.workItem,
        baseVersion:
          input.baseVersion ??
          (typeof workItemVersion === "number" ? workItemVersion : null),
      });
    },

    async deleteProjectMetadata(
      input: DeleteProjectMetadataInput
    ): Promise<void> {
      await rpc.deleteProject(accessToken, input.orgId, input.projectId);
    },

    async deleteWorkItemMetadata(
      input: DeleteWorkItemMetadataInput
    ): Promise<void> {
      await rpc.deleteWorkItem(accessToken, input.orgId, input.workItemId);
    },

    async listOrgState(input: ListOrgStateInput): Promise<CollabOrgState> {
      return toCollabOrgState(
        await rpc.listOrgCollabState(
          accessToken,
          input.orgId,
          input.sinceTimestamp
        )
      );
    },
  };
}
