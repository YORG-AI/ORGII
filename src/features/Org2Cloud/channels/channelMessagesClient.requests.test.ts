/**
 * Wire-level assertions for the channel MESSAGE RPC client — the contract the
 * message migration is written against: URL construction through
 * `endpointForOrg`, the raw-fetch header set, snake_case params for both read
 * modes (page cursor vs. `p_since` delta), tolerant row parsing, and the
 * non-ok → `Org2CloudChannelMessagesError` code mapping. Transport is cut at
 * `fetchWithTransportRetry`; `runCloudRequestWithTimeout` stays real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetOrgEndpointDirectory,
  setOrgEndpointDirectory,
} from "../org2CloudOrgEndpointRouter";
import {
  Org2CloudChannelMessagesError,
  deleteCloudChannelMessage,
  listCloudChannelMessages,
  postCloudChannelMessage,
  setCloudChannelReadCursor,
} from "./channelMessagesClient";

const mocks = vi.hoisted(() => ({
  fetchWithTransportRetry: vi.fn(),
}));

vi.mock("../org2CloudFetchRetry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../org2CloudFetchRetry")>();
  return { ...actual, fetchWithTransportRetry: mocks.fetchWithTransportRetry };
});

/** The org's HOME shard, not the official endpoint — routing must hit it. */
const SHARD_ENDPOINT = {
  webOrigin: "https://cloud.example.test",
  supabaseUrl: "https://shard.example.test",
  anonKey: "shard-anon",
  isOfficial: false,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastRequest(): { url: string; init: RequestInit } {
  const call = mocks.fetchWithTransportRetry.mock.calls.at(-1);
  expect(call).toBeDefined();
  const [url, init] = call as [string, RequestInit];
  return { url, init };
}

beforeEach(() => {
  vi.clearAllMocks();
  setOrgEndpointDirectory([["org-9", SHARD_ENDPOINT]]);
});

afterEach(() => {
  resetOrgEndpointDirectory();
});

describe("channelMessagesClient request building", () => {
  it("POSTs cloud_post_channel_message to the org's endpoint with auth headers", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({
        message: {
          id: "msg-1",
          channelId: "chan-1",
          authorUserId: "user-1",
          body: "ship it",
          createdAt: "2026-07-31T00:00:00.000Z",
        },
      })
    );

    const message = await postCloudChannelMessage(
      "token-1",
      "org-9",
      "chan-1",
      "ship it",
      { mentionedUserIds: ["user-2"] }
    );

    const { url, init } = lastRequest();
    expect(url).toBe(
      "https://shard.example.test/rest/v1/rpc/cloud_post_channel_message"
    );
    expect(init.headers).toEqual({
      apikey: "shard-anon",
      authorization: "Bearer token-1",
      "content-type": "application/json",
      "content-profile": "org2_cloud",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      p_org_id: "org-9",
      p_channel_id: "chan-1",
      p_body: "ship it",
      p_mentioned_user_ids: ["user-2"],
    });
    // Tolerant row parsing fills what the payload omitted.
    expect(message.editedAt).toBeNull();
    expect(message.mentionedUserIds).toEqual([]);
    // `stateChangedAt` falls back to createdAt so delta ordering always works.
    expect(message.stateChangedAt).toBe("2026-07-31T00:00:00.000Z");
  });

  it("adds p_client_key only when a clientKey option is given", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({
        message: {
          id: "msg-2",
          channelId: "chan-1",
          authorUserId: "user-1",
          body: "once",
          createdAt: "2026-07-31T00:00:00.000Z",
          clientKey: "key-1",
        },
      })
    );

    const message = await postCloudChannelMessage(
      "token-1",
      "org-9",
      "chan-1",
      "once",
      { clientKey: "key-1" }
    );

    // The named-arg set is the RPC signature on the wire: an extra key against
    // a pre-0016 backend is a signature mismatch, so absence above (the exact
    // `toEqual` in the previous case) and presence here are both contractual.
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      p_org_id: "org-9",
      p_channel_id: "chan-1",
      p_body: "once",
      p_mentioned_user_ids: [],
      p_client_key: "key-1",
    });
    expect(message.clientKey).toBe("key-1");
  });

  it("serializes the page read and the delta read as the two cursor params", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({ messages: [] })
    );
    await listCloudChannelMessages("token-1", "org-9", "chan-1");
    expect(lastRequest().url).toBe(
      "https://shard.example.test/rest/v1/rpc/cloud_list_channel_messages"
    );
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      p_org_id: "org-9",
      p_channel_id: "chan-1",
      p_cursor: null,
      p_limit: 50,
      p_since: null,
    });

    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({ messages: [] })
    );
    await listCloudChannelMessages("token-1", "org-9", "chan-1", {
      cursor: "2026-07-31T00:00:00.000Z|msg-1",
      limit: 20,
    });
    expect(JSON.parse(String(lastRequest().init.body))).toMatchObject({
      p_cursor: "2026-07-31T00:00:00.000Z|msg-1",
      p_limit: 20,
      p_since: null,
    });

    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({ messages: [] })
    );
    await listCloudChannelMessages("token-1", "org-9", "chan-1", {
      since: "2026-07-31T12:00:00.000Z",
    });
    expect(JSON.parse(String(lastRequest().init.body))).toMatchObject({
      p_cursor: null,
      p_since: "2026-07-31T12:00:00.000Z",
    });
  });

  it("keeps a tombstone's slot and never carries its body or mentions", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({
        messages: [
          {
            id: "msg-1",
            channelId: "chan-1",
            authorUserId: "user-1",
            body: "leaked",
            createdAt: "2026-07-31T00:00:00.000Z",
            deletedAt: "2026-07-31T01:00:00.000Z",
            // A pre-0017 backend still ships mentions on tombstones; the
            // read-side erasure must hold regardless of backend age.
            mentionedUserIds: ["user-2"],
          },
          { id: "malformed-row" },
        ],
        nextCursor: null,
        unreadCount: 3,
        serverTime: "2026-07-31T12:00:00.000Z",
        hasMore: false,
      })
    );

    const page = await listCloudChannelMessages("token-1", "org-9", "chan-1");
    // One malformed row degrades to nothing instead of blanking the page.
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].body).toBe("");
    expect(page.messages[0].mentionedUserIds).toEqual([]);
    expect(page.messages[0].stateChangedAt).toBe("2026-07-31T01:00:00.000Z");
    expect(page.unreadCount).toBe(3);
  });

  it("serializes the read cursor RPC and parses its counter", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({ lastReadAt: "2026-07-31T02:00:00.000Z", unreadCount: 0 })
    );

    const result = await setCloudChannelReadCursor(
      "token-1",
      "org-9",
      "chan-1",
      "2026-07-31T02:00:00.000Z"
    );
    expect(lastRequest().url).toBe(
      "https://shard.example.test/rest/v1/rpc/cloud_set_channel_read_cursor"
    );
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      p_org_id: "org-9",
      p_channel_id: "chan-1",
      p_last_read_at: "2026-07-31T02:00:00.000Z",
    });
    expect(result.unreadCount).toBe(0);
  });

  it("maps the message plane's own ORG2_* codes, whole-token only", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse(
        { message: "only managers may post (ORG2_CHANNEL_POST_FORBIDDEN)" },
        403
      )
    );

    const error: unknown = await postCloudChannelMessage(
      "token-1",
      "org-9",
      "chan-1",
      "hello"
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Org2CloudChannelMessagesError);
    const messagesError = error as Org2CloudChannelMessagesError;
    expect(messagesError.code).toBe("ORG2_CHANNEL_POST_FORBIDDEN");
    expect(messagesError.status).toBe(403);

    // A longer future code that merely CONTAINS a known one is not it.
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({ message: "ORG2_MESSAGE_NOT_FOUND_YET" }, 404)
    );
    const unknown: unknown = await deleteCloudChannelMessage(
      "token-1",
      "org-9",
      "msg-1"
    ).catch((caught: unknown) => caught);
    expect((unknown as Org2CloudChannelMessagesError).code).toBeNull();
  });
});
