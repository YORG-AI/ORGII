/**
 * Wire-level assertions for the channels RPC client: URL construction through
 * `endpointForOrg`, the raw-fetch header set (JWT Bearer + apikey +
 * `content-profile: org2_cloud`), snake_case param serialization, and the
 * non-ok → `Org2CloudChannelsError` mapping. Transport is cut at
 * `fetchWithTransportRetry`; `runCloudRequestWithTimeout` stays real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetOrgEndpointDirectory,
  setOrgEndpointDirectory,
} from "../org2CloudOrgEndpointRouter";
import {
  Org2CloudChannelsError,
  createCloudChannel,
  listCloudChannels,
} from "./channelsClient";

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

describe("channelsClient request building", () => {
  it("POSTs cloud_create_channel to the org's endpoint with auth headers and snake_case params", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({
        channel: {
          id: "chan-1",
          name: "code-review",
          createdAt: "2026-07-31T00:00:00.000Z",
        },
      })
    );

    const channel = await createCloudChannel("token-1", "org-9", {
      name: "code-review",
      visibility: "private",
      postPolicy: "managers",
      memberUserIds: ["user-1", "user-2"],
    });

    expect(mocks.fetchWithTransportRetry).toHaveBeenCalledTimes(1);
    const { url, init } = lastRequest();
    expect(url).toBe(
      "https://shard.example.test/rest/v1/rpc/cloud_create_channel"
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      apikey: "shard-anon",
      authorization: "Bearer token-1",
      "content-type": "application/json",
      "content-profile": "org2_cloud",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      p_org_id: "org-9",
      p_name: "code-review",
      p_topic: null,
      p_visibility: "private",
      p_post_policy: "managers",
      p_member_user_ids: ["user-1", "user-2"],
    });

    // The tolerant channel schema fills the unsent counters.
    expect(channel.id).toBe("chan-1");
    expect(channel.archivedAt).toBeNull();
    expect(channel.memberCount).toBe(0);
  });

  it("serializes p_include_archived for cloud_list_channels (default false)", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({ channels: [] })
    );

    await listCloudChannels("token-1", "org-9", { includeArchived: true });
    expect(lastRequest().url).toBe(
      "https://shard.example.test/rest/v1/rpc/cloud_list_channels"
    );
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      p_org_id: "org-9",
      p_include_archived: true,
    });

    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({ channels: [] })
    );
    await listCloudChannels("token-1", "org-9");
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      p_org_id: "org-9",
      p_include_archived: false,
    });
  });

  it("maps a non-ok response's ORG2_* body message onto Org2CloudChannelsError", async () => {
    mocks.fetchWithTransportRetry.mockResolvedValue(
      jsonResponse({ message: "duplicate channel name (ORG2_CONFLICT)" }, 409)
    );

    const error: unknown = await createCloudChannel("token-1", "org-9", {
      name: "code-review",
      visibility: "org",
      postPolicy: "everyone",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Org2CloudChannelsError);
    const channelsError = error as Org2CloudChannelsError;
    expect(channelsError.code).toBe("ORG2_CONFLICT");
    expect(channelsError.status).toBe(409);
    expect(channelsError.message).toBe(
      "duplicate channel name (ORG2_CONFLICT)"
    );
  });
});
