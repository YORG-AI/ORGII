/**
 * Org-channels RPC client — typed throwing wrappers for the ten
 * `0014_org_channels` RPCs.
 *
 * Same raw-fetch idiom as `memberRuntimeClient` (JWT Bearer +
 * `Content-Profile: org2_cloud`, no supabase-js), routed through
 * `endpointForOrg` so a sharded org talks to its home project, with
 * transport retry + a bounded timeout. Wrappers THROW `Org2CloudChannelsError`
 * carrying the server's `ORG2_*` code so dialogs can distinguish
 * name-taken (`ORG2_CONFLICT`) from permission (`ORG2_CHANNEL_MANAGER_REQUIRED`
 * / `ORG2_ADMIN_REQUIRED`) from last-manager (`ORG2_LAST_MANAGER`) failures.
 */
import { z } from "zod/v4";

import { createLogger } from "@src/hooks/logger";

import { type CloudEndpoint, ORG2_CLOUD_POSTGREST_SCHEMA } from "../config";
import {
  fetchWithTransportRetry,
  runCloudRequestWithTimeout,
} from "../org2CloudFetchRetry";
import { endpointForOrg } from "../org2CloudOrgEndpointRouter";
import type {
  CloudChannel,
  CloudChannelMember,
  CloudChannelRole,
  CloudChannelsList,
  CreateCloudChannelInput,
  UpdateCloudChannelInput,
} from "./types";
import {
  CHANNELS_ERROR_CODES,
  CloudChannelMembersSchema,
  CloudChannelSchema,
  CloudChannelsListSchema,
} from "./types";

const CHANNELS_REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type Org2ChannelsErrorCode = (typeof CHANNELS_ERROR_CODES)[number];

/** RPC failure carrying the server's error code when recognizable. */
export class Org2CloudChannelsError extends Error {
  readonly code: Org2ChannelsErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudChannelsError";
    this.status = status;
    // Whole-token match (org2CloudOrgManagement precedent): a longer future
    // code that textually contains a listed one must never be mis-mapped.
    const tokens = message.match(/\bORG2_[A-Z_]+\b/g) ?? [];
    this.code =
      (tokens.find((token) =>
        (CHANNELS_ERROR_CODES as readonly string[]).includes(token)
      ) as Org2ChannelsErrorCode | undefined) ?? null;
  }
}

export function isOrg2ChannelsErrorCode(
  error: unknown,
  code: Org2ChannelsErrorCode
): boolean {
  return error instanceof Org2CloudChannelsError && error.code === code;
}

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

const log = createLogger("Org2CloudChannels");

function rpcUrl(functionName: string, endpoint: CloudEndpoint): string {
  return `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`;
}

async function callChannelsRpc(
  functionName: string,
  accessToken: string,
  orgId: string,
  body: Record<string, unknown>,
  sourceSignal?: AbortSignal
): Promise<unknown> {
  const endpoint = endpointForOrg(orgId);
  // Mutations leave an INFO trace (reads stay quiet): the dual-instance
  // protocol audits cloud-state changes by log effect, and an unlogged
  // channel delete/archive is invisible to it.
  if (!functionName.startsWith("cloud_list_")) {
    log.info(
      `channels rpc ${functionName} org=${orgId}` +
        (typeof body.p_channel_id === "string"
          ? ` channel=${body.p_channel_id}`
          : "")
    );
  }
  return runCloudRequestWithTimeout(
    async (signal) => {
      const response = await fetchWithTransportRetry(
        rpcUrl(functionName, endpoint),
        {
          method: "POST",
          headers: {
            apikey: endpoint.anonKey,
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
          },
          body: JSON.stringify(body),
          signal,
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
        throw new Org2CloudChannelsError(message, response.status);
      }
      return payload;
    },
    CHANNELS_REQUEST_TIMEOUT_MS,
    sourceSignal
  );
}

const ChannelEnvelopeSchema = z.object({ channel: CloudChannelSchema });
const ArchiveResultSchema = z.object({
  archivedAt: z.string().nullable().catch(null),
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function listCloudChannels(
  accessToken: string,
  orgId: string,
  options?: { includeArchived?: boolean; signal?: AbortSignal }
): Promise<CloudChannelsList> {
  const payload = await callChannelsRpc(
    "cloud_list_channels",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_include_archived: options?.includeArchived ?? false,
    },
    options?.signal
  );
  return CloudChannelsListSchema.parse(payload);
}

export async function createCloudChannel(
  accessToken: string,
  orgId: string,
  input: CreateCloudChannelInput,
  signal?: AbortSignal
): Promise<CloudChannel> {
  const payload = await callChannelsRpc(
    "cloud_create_channel",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_name: input.name,
      p_topic: input.topic ?? null,
      p_visibility: input.visibility,
      p_post_policy: input.postPolicy,
      p_member_user_ids: [...(input.memberUserIds ?? [])],
    },
    signal
  );
  return ChannelEnvelopeSchema.parse(payload).channel;
}

export async function updateCloudChannel(
  accessToken: string,
  orgId: string,
  channelId: string,
  input: UpdateCloudChannelInput,
  signal?: AbortSignal
): Promise<void> {
  await callChannelsRpc(
    "cloud_update_channel",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_channel_id: channelId,
      p_name: input.name ?? null,
      p_topic: input.topic ?? null,
      p_post_policy: input.postPolicy ?? null,
    },
    signal
  );
}

export async function archiveCloudChannel(
  accessToken: string,
  orgId: string,
  channelId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const payload = await callChannelsRpc(
    "cloud_archive_channel",
    accessToken,
    orgId,
    { p_org_id: orgId, p_channel_id: channelId },
    signal
  );
  // HTTP 200 IS the success signal — a surprising body shape must not turn
  // a server-side archive into a client-side "failure" (the mutation landed).
  const parsed = ArchiveResultSchema.safeParse(payload);
  return parsed.success ? parsed.data.archivedAt : null;
}

export async function unarchiveCloudChannel(
  accessToken: string,
  orgId: string,
  channelId: string,
  signal?: AbortSignal
): Promise<void> {
  await callChannelsRpc(
    "cloud_unarchive_channel",
    accessToken,
    orgId,
    { p_org_id: orgId, p_channel_id: channelId },
    signal
  );
}

/** HARD delete — org owner/admin only (Slack semantics); irreversible. */
export async function deleteCloudChannel(
  accessToken: string,
  orgId: string,
  channelId: string,
  signal?: AbortSignal
): Promise<void> {
  // HTTP 200 is the success signal; the `ok` body is informational only —
  // parsing it strictly could report a completed delete as failed.
  await callChannelsRpc(
    "cloud_delete_channel",
    accessToken,
    orgId,
    { p_org_id: orgId, p_channel_id: channelId },
    signal
  );
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export async function listCloudChannelMembers(
  accessToken: string,
  orgId: string,
  channelId: string,
  signal?: AbortSignal
): Promise<CloudChannelMember[]> {
  const payload = await callChannelsRpc(
    "cloud_list_channel_members",
    accessToken,
    orgId,
    { p_org_id: orgId, p_channel_id: channelId },
    signal
  );
  return CloudChannelMembersSchema.parse(payload).members;
}

export async function addCloudChannelMembers(
  accessToken: string,
  orgId: string,
  channelId: string,
  userIds: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  await callChannelsRpc(
    "cloud_add_channel_members",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_channel_id: channelId,
      p_user_ids: [...userIds],
    },
    signal
  );
}

/** Managers/org admins remove anyone; any member removes THEMSELVES (leave). */
export async function removeCloudChannelMember(
  accessToken: string,
  orgId: string,
  channelId: string,
  userId: string,
  signal?: AbortSignal
): Promise<void> {
  await callChannelsRpc(
    "cloud_remove_channel_member",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_channel_id: channelId,
      p_user_id: userId,
    },
    signal
  );
}

export async function setCloudChannelMemberRole(
  accessToken: string,
  orgId: string,
  channelId: string,
  userId: string,
  role: CloudChannelRole,
  signal?: AbortSignal
): Promise<void> {
  await callChannelsRpc(
    "cloud_set_channel_member_role",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_channel_id: channelId,
      p_user_id: userId,
      p_role: role,
    },
    signal
  );
}
