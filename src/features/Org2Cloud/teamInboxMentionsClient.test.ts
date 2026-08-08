import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod/v4";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import { __CAPABILITIES_INTERNALS } from "./org2CloudCapabilities";
import { Org2CloudCommentError } from "./org2CloudCommentsClient";
import {
  listInitialTeamInboxMentions,
  listTeamInboxMentions,
  markAllTeamInboxMentionsRead,
  setTeamInboxMentionRead,
} from "./teamInboxMentionsClient";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body)) as Record<string, unknown>;
}

const WIRE_MENTION = {
  comment: { id: "comment-2", parentId: "comment-1" },
  session: { id: "session-1", title: "Fix Team Inbox" },
  author: { userId: "user-a", displayName: "Alice" },
  body: "Please review this change",
  createdAt: "2026-07-23T10:00:00.000Z",
  readAt: null,
  commentCount: 4,
  threadCount: 2,
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  __CAPABILITIES_INTERNALS.reset();
});

describe("listInitialTeamInboxMentions", () => {
  it("keeps older endpoints on the local-only path without probing a missing RPC", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        broadcastSignals: true,
        storageSegments: true,
        teamInboxMentions: false,
      })
    );

    await expect(
      listInitialTeamInboxMentions("jwt-viewer", "org-1")
    ).resolves.toEqual({ mentions: [], unreadCount: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/get_cloud_capabilities`
    );
  });

  it("loads the first page after the endpoint advertises mention support", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          broadcastSignals: true,
          storageSegments: true,
          teamInboxMentions: true,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          mentions: [WIRE_MENTION],
          nextCursor: null,
          unreadCount: 1,
        })
      );

    await expect(
      listInitialTeamInboxMentions("jwt-viewer", "org-1", 25)
    ).resolves.toEqual({
      mentions: [WIRE_MENTION],
      nextCursor: undefined,
      unreadCount: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastCall().url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_list_team_inbox_mentions`
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_cursor: null,
      p_limit: 25,
    });
  });
});

describe("listTeamInboxMentions", () => {
  it("posts the managed-cloud wire contract without a viewer identity", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mentions: [WIRE_MENTION],
        nextCursor: "cursor-2",
        unreadCount: 7,
      })
    );

    await listTeamInboxMentions("jwt-viewer", "org-1", "cursor-1", 25);

    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_list_team_inbox_mentions`
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      apikey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
      authorization: "Bearer jwt-viewer",
      "content-type": "application/json",
      "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
    });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_cursor: "cursor-1",
      p_limit: 25,
    });
    expect(lastBody()).not.toHaveProperty("p_viewer_id");
    expect(lastBody()).not.toHaveProperty("p_user_id");
  });

  it("sends a null cursor for the first page", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ mentions: [], nextCursor: null, unreadCount: 0 })
    );

    await listTeamInboxMentions("jwt-viewer", "org-1", null, 50);

    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_cursor: null,
      p_limit: 50,
    });
  });

  it("parses the stable mention response contract", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mentions: [WIRE_MENTION],
        nextCursor: "cursor-2",
        unreadCount: 7,
      })
    );

    const page = await listTeamInboxMentions("jwt-viewer", "org-1", null, 25);

    expect(page).toEqual({
      mentions: [WIRE_MENTION],
      nextCursor: "cursor-2",
      unreadCount: 7,
    });
  });

  it("normalizes nullable optional fields and terminal cursor", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mentions: [
          {
            ...WIRE_MENTION,
            comment: { id: "comment-2", parentId: null },
            session: { id: "session-1", title: null },
            author: { userId: "user-a", displayName: null },
          },
        ],
        nextCursor: null,
        unreadCount: 1,
      })
    );

    const page = await listTeamInboxMentions("jwt-viewer", "org-1", null, 25);

    expect(page.nextCursor).toBeUndefined();
    expect(page.mentions[0]).toMatchObject({
      comment: { id: "comment-2", parentId: undefined },
      session: { id: "session-1", title: undefined },
      author: { userId: "user-a", displayName: undefined },
    });
  });

  it("drops a malformed mention row alone instead of leaking raw wire data", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mentions: [
          { ...WIRE_MENTION, commentCount: -1 },
          { ...WIRE_MENTION, comment: { id: "comment-9", parentId: null } },
        ],
        nextCursor: null,
        unreadCount: 1,
      })
    );

    const page = await listTeamInboxMentions("jwt-viewer", "org-1", null, 25);

    // The malformed row costs only itself — never surfaced raw, never fatal.
    expect(page.mentions).toHaveLength(1);
    expect(page.mentions[0].comment.id).toBe("comment-9");
    expect(page.unreadCount).toBe(1);
  });

  it("rejects a malformed page envelope outright", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mentions: [WIRE_MENTION],
        nextCursor: null,
        unreadCount: -1,
      })
    );

    await expect(
      listTeamInboxMentions("jwt-viewer", "org-1", null, 25)
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("validates pagination input before making a request", async () => {
    await expect(
      listTeamInboxMentions("jwt-viewer", "org-1", null, 0)
    ).rejects.toBeInstanceOf(ZodError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws the comments client RPC error without backend fallback", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_MEMBER_REQUIRED" }, 403)
    );

    const error = await listTeamInboxMentions(
      "jwt-viewer",
      "org-1",
      null,
      25
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Org2CloudCommentError);
    expect(error).toMatchObject({ code: "ORG2_MEMBER_REQUIRED", status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight RPC when its owning Inbox scope is disposed", async () => {
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>(() => undefined)
    );
    const controller = new AbortController();

    const request = listTeamInboxMentions(
      "jwt-viewer",
      "org-1",
      null,
      25,
      controller.signal
    );
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect((lastCall().init.signal as AbortSignal).aborted).toBe(true);
  });
});

describe("Team Inbox read receipts", () => {
  it("persists a single receipt without sending a viewer id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        readAt: "2026-07-27T12:00:00.000Z",
        unreadCount: 2,
      })
    );

    const result = await setTeamInboxMentionRead(
      "jwt-viewer",
      "org-1",
      "comment-2",
      true
    );

    expect(lastCall().url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_set_team_inbox_mention_read`
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_comment_id: "comment-2",
      p_read: true,
    });
    expect(lastBody()).not.toHaveProperty("p_viewer_user_id");
    expect(result).toEqual({
      readAt: "2026-07-27T12:00:00.000Z",
      unreadCount: 2,
    });
  });

  it("marks all server-side, including unloaded pages", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        readAt: "2026-07-27T12:00:00.000Z",
        unreadCount: 0,
      })
    );

    await markAllTeamInboxMentionsRead("jwt-viewer", "org-1");

    expect(lastCall().url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_mark_all_team_inbox_mentions_read`
    );
    expect(lastBody()).toEqual({ p_org_id: "org-1" });
  });
});
