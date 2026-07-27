import { z } from "zod/v4";

import { ORG2_CLOUD_POSTGREST_SCHEMA, getCloudEndpoint } from "./config";
import { Org2CloudCommentError } from "./org2CloudCommentsClient";

const TEAM_INBOX_MENTIONS_RPC = "cloud_list_team_inbox_mentions";

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
  commentCount: z.number().int().nonnegative(),
  threadCount: z.number().int().nonnegative(),
});

const TeamInboxMentionsPageSchema = z.object({
  mentions: z.array(TeamInboxMentionSchema).default([]),
  nextCursor: NullableStringSchema,
});

export type TeamInboxMention = z.output<typeof TeamInboxMentionSchema>;

export interface TeamInboxMentionsPage {
  mentions: TeamInboxMention[];
  nextCursor?: string;
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
  const endpoint = getCloudEndpoint();
  const response = await fetch(
    `${endpoint.supabaseUrl}/rest/v1/rpc/${TEAM_INBOX_MENTIONS_RPC}`,
    {
      method: "POST",
      headers: {
        apikey: endpoint.anonKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
      },
      body: JSON.stringify({
        p_org_id: input.orgId,
        p_cursor: input.cursor,
        p_limit: input.limit,
      }),
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
        : `org2_cloud rpc ${TEAM_INBOX_MENTIONS_RPC} failed with ${response.status}`;
    throw new Org2CloudCommentError(message, response.status);
  }

  return TeamInboxMentionsPageSchema.parse(payload);
}
