import { z } from "zod/v4";

import { ORG2_CLOUD_POSTGREST_SCHEMA, getCloudEndpoint } from "./config";
import { getCloudCapabilities } from "./org2CloudCapabilities";
import { Org2CloudCommentError } from "./org2CloudCommentsClient";
import { fetchWithTransportRetry } from "./org2CloudFetchRetry";

const TEAM_INBOX_MENTIONS_RPC = "cloud_list_team_inbox_mentions";
const SET_TEAM_INBOX_MENTION_READ_RPC = "cloud_set_team_inbox_mention_read";
const MARK_ALL_TEAM_INBOX_MENTIONS_READ_RPC =
  "cloud_mark_all_team_inbox_mentions_read";

const TeamInboxMentionRequestSchema = z.object({
  orgId: z.string().min(1),
  cursor: z.string().min(1).nullable(),
  limit: z.number().int().min(1).max(100),
});

const NullableStringSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
  .optional();

const TeamInboxMentionSchema = z.object({
  comment: z.object({
    id: z.string(),
    parentId: NullableStringSchema,
  }),
  session: z.object({
    id: z.string(),
    title: NullableStringSchema,
  }),
  author: z.object({
    userId: z.string(),
    displayName: NullableStringSchema,
  }),
  body: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  commentCount: z.number().int().nonnegative(),
  threadCount: z.number().int().nonnegative(),
});

const TeamInboxMentionsPageSchema = z.object({
  mentions: z.array(TeamInboxMentionSchema).default([]),
  nextCursor: NullableStringSchema,
  unreadCount: z.number().int().nonnegative(),
});

export type TeamInboxMention = z.output<typeof TeamInboxMentionSchema>;

export interface TeamInboxMentionsPage {
  mentions: TeamInboxMention[];
  nextCursor?: string;
  unreadCount: number;
}

const EMPTY_TEAM_INBOX_MENTIONS_PAGE: TeamInboxMentionsPage = {
  mentions: [],
  unreadCount: 0,
};

const TeamInboxReadMutationSchema = z.object({
  readAt: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});

export interface TeamInboxReadMutation {
  readAt: string | null;
  unreadCount: number;
}

async function callTeamInboxRpc(
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
    throw new Org2CloudCommentError(message, response.status);
  }
  return payload;
}

/**
 * Lists managed-cloud comment mentions for the authenticated viewer.
 *
 * The viewer is derived by the RPC from the JWT bearer token. The client does
 * not accept or send a viewer/user id, inspect comment bodies for mentions, or
 * maintain a local projection of the result.
 */
export async function listTeamInboxMentions(
  accessToken: string,
  orgId: string,
  cursor: string | null,
  limit: number
): Promise<TeamInboxMentionsPage> {
  const input = TeamInboxMentionRequestSchema.parse({ orgId, cursor, limit });
  const payload = await callTeamInboxRpc(TEAM_INBOX_MENTIONS_RPC, accessToken, {
    p_org_id: input.orgId,
    p_cursor: input.cursor,
    p_limit: input.limit,
  });
  return TeamInboxMentionsPageSchema.parse(payload);
}

/**
 * Lists the first mention page only when the endpoint advertises migration
 * 0010. Older deployments keep local assigned work available without probing
 * a missing RPC.
 */
export async function listInitialTeamInboxMentions(
  accessToken: string,
  orgId: string,
  limit = 50
): Promise<TeamInboxMentionsPage> {
  const capabilities = await getCloudCapabilities(accessToken);
  if (!capabilities.teamInboxMentions) {
    return EMPTY_TEAM_INBOX_MENTIONS_PAGE;
  }
  return listTeamInboxMentions(accessToken, orgId, null, limit);
}

/** Persists one viewer-scoped mention receipt. The viewer comes from JWT. */
export async function setTeamInboxMentionRead(
  accessToken: string,
  orgId: string,
  commentId: string,
  read: boolean
): Promise<TeamInboxReadMutation> {
  const payload = await callTeamInboxRpc(
    SET_TEAM_INBOX_MENTION_READ_RPC,
    accessToken,
    {
      p_org_id: z.string().min(1).parse(orgId),
      p_comment_id: z.string().min(1).parse(commentId),
      p_read: read,
    }
  );
  return TeamInboxReadMutationSchema.parse(payload);
}

/** Marks every currently visible mention read, including unloaded pages. */
export async function markAllTeamInboxMentionsRead(
  accessToken: string,
  orgId: string
): Promise<TeamInboxReadMutation> {
  const payload = await callTeamInboxRpc(
    MARK_ALL_TEAM_INBOX_MENTIONS_READ_RPC,
    accessToken,
    { p_org_id: z.string().min(1).parse(orgId) }
  );
  return TeamInboxReadMutationSchema.parse(payload);
}
