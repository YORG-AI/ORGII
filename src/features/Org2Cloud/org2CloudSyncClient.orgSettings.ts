/**
 * Org governance RPCs (repo scopes, sharing floors, background-upload policy)
 * plus the single-session metadata upsert and soft tombstone that ride the
 * same admin/owner surface.
 */
import type {
  CollabSessionAccessMode,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";

import { endpointForOrg } from "./org2CloudOrgEndpointRouter";
import { callSyncRpc } from "./org2CloudSyncClient.rpc";
import type { CloudOrgScopeState } from "./org2CloudSyncClient.schemas";
import { CloudOrgScopeStateSchema } from "./org2CloudSyncClient.schemas";

/**
 * Member: repo-scope governance state for one org — the authoritative scope
 * list (hydrates the local mirror on other devices) plus quota occupancy and
 * cooling-down slots.
 */
export async function getOrgRepoScopes(
  accessToken: string,
  orgId: string
): Promise<CloudOrgScopeState> {
  const payload = await callSyncRpc(
    "cloud_get_org_repo_scopes",
    accessToken,
    { p_org_id: orgId },
    endpointForOrg(orgId)
  );
  return CloudOrgScopeStateSchema.parse(payload);
}

/**
 * Admin-only: replace the org's repo scopes (normalized remote keys).
 * Removing a scope starts its cooldown server-side; re-adding one whose slot
 * is still cooling raises ORG2_SCOPE_COOLDOWN with an ISO frees-at suffix.
 */
export async function setOrgRepoScopes(
  accessToken: string,
  orgId: string,
  scopes: string[]
): Promise<void> {
  await callSyncRpc("cloud_set_org_repo_scopes", accessToken, {
    p_org_id: orgId,
    scopes,
  });
}

/**
 * Admin-only (0002): set the org sharing FLOOR — the minimum access mode a
 * member may share a session at ('off' | 'metadata_only' | 'full_replay').
 * Throws Org2CloudSyncError on failure (ORG2_ADMIN_REQUIRED for non-admins,
 * ORG2_VALIDATION for a bad value).
 */
export async function setOrgSharingFloor(
  accessToken: string,
  orgId: string,
  floor: CollabSessionAccessMode
): Promise<void> {
  await callSyncRpc("cloud_set_org_sharing_floor", accessToken, {
    p_org_id: orgId,
    p_floor: floor,
  });
}

/**
 * Admin-only: set ONE member's sharing floor (per-member minimum). 'off'
 * clears the member-level requirement — the org-wide floor still applies;
 * the member's effective floor is max(org floor, member floor), merged
 * server-side into their `get_entitlement_state.orgSharingFloor`. Throws
 * Org2CloudSyncError (ORG2_ADMIN_REQUIRED / ORG2_MEMBER_NOT_FOUND /
 * ORG2_VALIDATION).
 */
export async function setMemberSharingFloor(
  accessToken: string,
  orgId: string,
  userId: string,
  floor: CollabSessionAccessMode
): Promise<void> {
  await callSyncRpc("cloud_set_member_sharing_floor", accessToken, {
    p_org_id: orgId,
    p_user_id: userId,
    p_floor: floor,
  });
}

/** Member (owner-updates-only): upsert one session's metadata. */
export async function upsertSessionMetadata(
  accessToken: string,
  orgId: string,
  sessionId: string,
  metadata: RemoteTeammateSessionMetadata
): Promise<void> {
  await callSyncRpc(
    "cloud_upsert_session_metadata",
    accessToken,
    {
      p_org_id: orgId,
      p_session_id: sessionId,
      metadata,
    },
    endpointForOrg(orgId)
  );
}

/**
 * Owner-only soft tombstone: removes a session from the org's shared list
 * (segments are kept server-side). Used when a session is untagged from a
 * cloud org — it should disappear from that org promptly. If the session is
 * still repo-scope-matched, the next sync pass re-creates it (the upsert
 * clears `deleted_at`), so this is safe to call unconditionally on untag.
 */
export async function deleteSession(
  accessToken: string,
  orgId: string,
  sessionId: string
): Promise<void> {
  await callSyncRpc(
    "cloud_delete_session",
    accessToken,
    { p_org_id: orgId, p_session_id: sessionId },
    endpointForOrg(orgId)
  );
}

/**
 * Admin-only (0013): flip the org-wide background-upload policy. The RPC
 * keeps its legacy offline-sync name for wire compatibility. Server nudges
 * the policy plane so open member clients refetch their roster live.
 */
export async function setOrgBackgroundUpload(
  accessToken: string,
  orgId: string,
  enabled: boolean
): Promise<void> {
  await callSyncRpc(
    "cloud_set_org_offline_sync",
    accessToken,
    { p_org_id: orgId, p_enabled: enabled },
    endpointForOrg(orgId)
  );
}
