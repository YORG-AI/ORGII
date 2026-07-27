import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod/v4";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import { Org2CloudCommentError } from "./org2CloudCommentsClient";
import { listTeamInboxMentions } from "./teamInboxMentionsClient";

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
  commentCount: 4,
  threadCount: 2,
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("listTeamInboxMentions", () => {
  it("posts the managed-cloud wire contract without a viewer identity", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ mentions: [WIRE_MENTION], nextCursor: "cursor-2" })
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
      jsonResponse({ mentions: [], nextCursor: null })
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
      jsonResponse({ mentions: [WIRE_MENTION], nextCursor: "cursor-2" })
    );

    const page = await listTeamInboxMentions("jwt-viewer", "org-1", null, 25);

    expect(page).toEqual({
      mentions: [WIRE_MENTION],
      nextCursor: "cursor-2",
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

  it("rejects malformed response fields instead of leaking raw wire data", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mentions: [{ ...WIRE_MENTION, commentCount: -1 }],
        nextCursor: null,
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
});
