/**
 * Org-channel MESSAGE RPC client — typed throwing wrappers for the five
 * message-plane RPCs, in the same idiom as its control-plane sibling
 * `channelsClient.ts`: raw fetch (JWT Bearer + `Content-Profile: org2_cloud`,
 * no supabase-js), routed through `endpointForOrg` so a sharded org talks to
 * its home project, with transport retry + a bounded timeout.
 *
 * The RPC plumbing is deliberately NOT imported from `channelsClient`: these
 * calls must reject with an error whose code list also covers the message
 * plane's own refusals (`ORG2_CHANNEL_POST_FORBIDDEN`,
 * `ORG2_CHANNEL_ARCHIVED`, `ORG2_MESSAGE_NOT_FOUND`), and the composer
 * distinguishes them by code, not by message text.
 */
import { type CloudEndpoint, ORG2_CLOUD_POSTGREST_SCHEMA } from "../config";
import {
  fetchWithTransportRetry,
  runCloudRequestWithTimeout,
} from "../org2CloudFetchRetry";
import { endpointForOrg } from "../org2CloudOrgEndpointRouter";
import type {
  CloudChannelMessage,
  CloudChannelMessagesPage,
  CloudChannelReadCursor,
} from "./channelMessagesTypes";
import {
  CHANNEL_MESSAGES_ERROR_CODES,
  CHANNEL_MESSAGES_PAGE_SIZE,
  CloudChannelMessageEnvelopeSchema,
  CloudChannelMessagesPageSchema,
  CloudChannelReadCursorSchema,
} from "./channelMessagesTypes";

const CHANNEL_MESSAGES_REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type Org2ChannelMessagesErrorCode =
  (typeof CHANNEL_MESSAGES_ERROR_CODES)[number];

/** RPC failure carrying the server's error code when recognizable. */
export class Org2CloudChannelMessagesError extends Error {
  readonly code: Org2ChannelMessagesErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudChannelMessagesError";
    this.status = status;
    // Whole-token match (org2CloudOrgManagement precedent): a longer future
    // code that textually contains a listed one must never be mis-mapped —
    // `ORG2_CHANNEL_ARCHIVED_FOREVER` is not `ORG2_CHANNEL_ARCHIVED`.
    const tokens = message.match(/\bORG2_[A-Z_]+\b/g) ?? [];
    this.code =
      (tokens.find((token) =>
        (CHANNEL_MESSAGES_ERROR_CODES as readonly string[]).includes(token)
      ) as Org2ChannelMessagesErrorCode | undefined) ?? null;
  }
}

export function isOrg2ChannelMessagesErrorCode(
  error: unknown,
  code: Org2ChannelMessagesErrorCode
): boolean {
  return error instanceof Org2CloudChannelMessagesError && error.code === code;
}

/** The server's code for an error, or null when it is not a message RPC one. */
export function org2ChannelMessagesErrorCode(
  error: unknown
): Org2ChannelMessagesErrorCode | null {
  return error instanceof Org2CloudChannelMessagesError ? error.code : null;
}

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

function rpcUrl(functionName: string, endpoint: CloudEndpoint): string {
  return `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`;
}

async function callChannelMessagesRpc(
  functionName: string,
  accessToken: string,
  orgId: string,
  body: Record<string, unknown>,
  sourceSignal?: AbortSignal
): Promise<unknown> {
  const endpoint = endpointForOrg(orgId);
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
        throw new Org2CloudChannelMessagesError(message, response.status);
      }
      return payload;
    },
    CHANNEL_MESSAGES_REQUEST_TIMEOUT_MS,
    sourceSignal
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListCloudChannelMessagesOptions {
  /** Keyset cursor from a previous page (`"<ISO>|<uuid>"`); older rows. */
  cursor?: string | null;
  limit?: number;
  /** Delta mode: rows whose `stateChangedAt` is newer than this timestamp. */
  since?: string | null;
  signal?: AbortSignal;
}

export async function listCloudChannelMessages(
  accessToken: string,
  orgId: string,
  channelId: string,
  options?: ListCloudChannelMessagesOptions
): Promise<CloudChannelMessagesPage> {
  const payload = await callChannelMessagesRpc(
    "cloud_list_channel_messages",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_channel_id: channelId,
      p_cursor: options?.cursor ?? null,
      // Delta mode is server-capped (200 + hasMore) and ignores p_limit;
      // sending the page size there misdescribes the read on the wire.
      p_limit:
        options?.since != null
          ? null
          : (options?.limit ?? CHANNEL_MESSAGES_PAGE_SIZE),
      p_since: options?.since ?? null,
    },
    options?.signal
  );
  return CloudChannelMessagesPageSchema.parse(payload);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function postCloudChannelMessage(
  accessToken: string,
  orgId: string,
  channelId: string,
  body: string,
  options?: {
    mentionedUserIds?: readonly string[];
    /**
     * Idempotency key (0016). Only send when the backend advertises
     * `orgChannelMessagesIdempotency` — an older backend rejects the unknown
     * argument as a signature mismatch.
     */
    clientKey?: string;
    signal?: AbortSignal;
  }
): Promise<CloudChannelMessage> {
  const payload = await callChannelMessagesRpc(
    "cloud_post_channel_message",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_channel_id: channelId,
      p_body: body,
      p_mentioned_user_ids: [...(options?.mentionedUserIds ?? [])],
      ...(options?.clientKey != null
        ? { p_client_key: options.clientKey }
        : {}),
    },
    options?.signal
  );
  return CloudChannelMessageEnvelopeSchema.parse(payload).message;
}

export async function editCloudChannelMessage(
  accessToken: string,
  orgId: string,
  messageId: string,
  body: string,
  signal?: AbortSignal
): Promise<CloudChannelMessage> {
  const payload = await callChannelMessagesRpc(
    "cloud_edit_channel_message",
    accessToken,
    orgId,
    { p_org_id: orgId, p_message_id: messageId, p_body: body },
    signal
  );
  return CloudChannelMessageEnvelopeSchema.parse(payload).message;
}

/** TOMBSTONE delete — the row keeps its slot with `deletedAt` stamped. */
export async function deleteCloudChannelMessage(
  accessToken: string,
  orgId: string,
  messageId: string,
  signal?: AbortSignal
): Promise<void> {
  await callChannelMessagesRpc(
    "cloud_delete_channel_message",
    accessToken,
    orgId,
    { p_org_id: orgId, p_message_id: messageId },
    signal
  );
}

export async function setCloudChannelReadCursor(
  accessToken: string,
  orgId: string,
  channelId: string,
  lastReadAt: string,
  signal?: AbortSignal
): Promise<CloudChannelReadCursor> {
  const payload = await callChannelMessagesRpc(
    "cloud_set_channel_read_cursor",
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_channel_id: channelId,
      p_last_read_at: lastReadAt,
    },
    signal
  );
  return CloudChannelReadCursorSchema.parse(payload);
}
