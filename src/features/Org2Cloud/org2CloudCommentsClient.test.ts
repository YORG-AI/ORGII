import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import {
  Org2CloudCommentError,
  addSessionComment,
  deleteSessionComment,
  editSessionComment,
  isOrg2CommentErrorCode,
  listSessionComments,
  resolveSessionComment,
} from "./org2CloudCommentsClient";

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

const WIRE_COMMENT = {
  id: "comment-1",
  eventId: null,
  parentId: null,
  authorUserId: "user-a",
  authorDisplayName: "Alice",
  body: "looks wrong here",
  createdAt: "2026-07-07T10:00:00.000Z",
  editedAt: null,
  deletedAt: null,
  resolvedAt: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(jsonResponse(null));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("addSessionComment", () => {
  it("posts the base arg set and parses the {comment:{…}} return", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ comment: WIRE_COMMENT }));
    const comment = await addSessionComment("jwt-1", {
      orgId: "org-1",
      sessionId: "sess-1",
      body: "looks wrong here",
    });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_session_id: "sess-1",
      p_body: "looks wrong here",
      p_event_id: null,
      p_parent_id: null,
    });
    expect(comment.id).toBe("comment-1");
    // Nullish wire fields normalize to undefined (protocol.ts idiom).
    expect(comment.eventId).toBeUndefined();
    expect(comment.parentId).toBeUndefined();
    expect(comment.resolvedAt).toBeUndefined();
    expect(comment.authorDisplayName).toBe("Alice");
  });

  it("sends the additive kind argument only for an agent report", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        comment: { ...WIRE_COMMENT, kind: "agent_report" },
      })
    );
    await addSessionComment("jwt-1", {
      orgId: "org-1",
      sessionId: "sess-1",
      body: "agent result",
      kind: "agent_report",
    });
    expect(lastBody().p_kind).toBe("agent_report");
  });

  it("sends the turn anchor when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ comment: { ...WIRE_COMMENT, eventId: "evt-9" } })
    );
    const comment = await addSessionComment("jwt-1", {
      orgId: "org-1",
      sessionId: "sess-1",
      body: "pinned to a turn",
      eventId: "evt-9",
    });
    expect(lastBody().p_event_id).toBe("evt-9");
    expect(lastBody().p_parent_id).toBeNull();
    expect(comment.eventId).toBe("evt-9");
  });

  it("sends the reply parent WITHOUT an anchor (replies inherit it)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ comment: { ...WIRE_COMMENT, parentId: "comment-0" } })
    );
    await addSessionComment("jwt-1", {
      orgId: "org-1",
      sessionId: "sess-1",
      body: "agreed",
      parentId: "comment-0",
    });
    expect(lastBody().p_parent_id).toBe("comment-0");
    expect(lastBody().p_event_id).toBeNull();
  });

  it("sends JWT bearer + Content-Profile", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ comment: WIRE_COMMENT }));
    await addSessionComment("jwt-9", {
      orgId: "org-1",
      sessionId: "sess-1",
      body: "hi",
    });
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_add_session_comment`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-9");
    expect(headers["content-profile"]).toBe(ORG2_CLOUD_POSTGREST_SCHEMA);
  });

  it("maps ORG2_REPLAY_NOT_AVAILABLE into a coded error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_REPLAY_NOT_AVAILABLE" }, 400)
    );
    const error = await addSessionComment("jwt-1", {
      orgId: "org-1",
      sessionId: "sess-1",
      body: "hi",
      eventId: "evt-1",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudCommentError);
    expect(isOrg2CommentErrorCode(error, "ORG2_REPLAY_NOT_AVAILABLE")).toBe(
      true
    );
  });

  it("maps ORG2_QUOTA_EXCEEDED (500-row cap) into a coded error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_QUOTA_EXCEEDED" }, 400)
    );
    const error = await addSessionComment("jwt-1", {
      orgId: "org-1",
      sessionId: "sess-1",
      body: "hi",
    }).catch((caught: unknown) => caught);
    expect(isOrg2CommentErrorCode(error, "ORG2_QUOTA_EXCEEDED")).toBe(true);
  });
});

describe("editSessionComment", () => {
  it("posts the body and returns the new editedAt", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, editedAt: "2026-07-07T11:00:00.000Z" })
    );
    const editedAt = await editSessionComment(
      "jwt-1",
      "org-1",
      "comment-1",
      "fixed wording"
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_comment_id: "comment-1",
      p_body: "fixed wording",
    });
    expect(editedAt).toBe("2026-07-07T11:00:00.000Z");
  });

  it("maps ORG2_FORBIDDEN (non-author edit)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_FORBIDDEN" }, 400)
    );
    const error = await editSessionComment(
      "jwt-1",
      "org-1",
      "comment-1",
      "nope"
    ).catch((caught: unknown) => caught);
    expect(isOrg2CommentErrorCode(error, "ORG2_FORBIDDEN")).toBe(true);
  });
});

describe("deleteSessionComment", () => {
  it("posts the comment id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await deleteSessionComment("jwt-1", "org-1", "comment-1");
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_comment_id: "comment-1",
    });
  });
});

describe("resolveSessionComment", () => {
  it("posts p_resolved=true on resolve", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await resolveSessionComment("jwt-1", "org-1", "comment-1", true);
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_comment_id: "comment-1",
      p_resolved: true,
    });
  });

  it("posts p_resolved=false on unresolve", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await resolveSessionComment("jwt-1", "org-1", "comment-1", false);
    expect(lastBody().p_resolved).toBe(false);
  });

  it("omits p_resolution for a plain resolve (pre-delta compatible)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await resolveSessionComment(
      "jwt-1",
      "org-1",
      "comment-1",
      true,
      "resolved"
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_comment_id: "comment-1",
      p_resolved: true,
    });
  });

  it("sends p_resolution for wont_fix", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await resolveSessionComment(
      "jwt-1",
      "org-1",
      "comment-1",
      true,
      "wont_fix"
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_comment_id: "comment-1",
      p_resolved: true,
      p_resolution: "wont_fix",
    });
  });

  it("degrades wont_fix to a plain resolve on a signature-mismatch 404", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ message: "Could not find the function" }, 404)
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await resolveSessionComment(
      "jwt-1",
      "org-1",
      "comment-1",
      true,
      "wont_fix"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_comment_id: "comment-1",
      p_resolved: true,
    });
  });

  it("does not retry a non-404 wont_fix failure", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_FORBIDDEN" }, 403)
    );
    await expect(
      resolveSessionComment("jwt-1", "org-1", "comment-1", true, "wont_fix")
    ).rejects.toMatchObject({ code: "ORG2_FORBIDDEN" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("listSessionComments", () => {
  it("parses entries and normalizes nullish fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        comments: [
          WIRE_COMMENT,
          {
            id: "comment-2",
            eventId: "evt-1",
            parentId: null,
            authorUserId: "user-b",
            // Missing profile: LEFT JOIN yields null, never a dropped row.
            authorDisplayName: null,
            body: "",
            createdAt: "2026-07-07T10:05:00.000Z",
            editedAt: null,
            deletedAt: "2026-07-07T10:10:00.000Z",
            resolvedAt: "2026-07-07T10:07:00.000Z",
          },
        ],
      })
    );
    const { comments } = await listSessionComments("jwt-1", "org-1", "sess-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_session_id: "sess-1" });
    expect(comments).toHaveLength(2);
    expect(comments[0].authorDisplayName).toBe("Alice");
    expect(comments[1].authorDisplayName).toBeUndefined();
    // Pre-0002 wire (no `kind` key) ⇒ undefined ⇒ 'user' semantics.
    expect(comments[0].kind).toBeUndefined();
    // Tombstone: empty body + deletedAt survive the round-trip.
    expect(comments[1].body).toBe("");
    expect(comments[1].deletedAt).toBe("2026-07-07T10:10:00.000Z");
    expect(comments[1].resolvedAt).toBe("2026-07-07T10:07:00.000Z");
    // Pre-delta wire (no `resolution` key) ⇒ undefined.
    expect(comments[1].resolution).toBeUndefined();
  });

  it("parses the resolution verdict when present", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        comments: [
          {
            ...WIRE_COMMENT,
            resolvedAt: "2026-07-11T10:00:00.000Z",
            resolution: "wont_fix",
          },
        ],
      })
    );
    const { comments } = await listSessionComments("jwt-1", "org-1", "sess-1");
    expect(comments[0].resolution).toBe("wont_fix");
  });

  it("defaults absent comments AND tasks arrays (pre-0002 backend)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(
      listSessionComments("jwt-1", "org-1", "sess-1")
    ).resolves.toEqual({ comments: [], tasks: [] });
  });

  it("parses the 0002 tasks embed and per-comment kind", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        comments: [{ ...WIRE_COMMENT, kind: "agent_report" }],
        tasks: [
          {
            id: "task-1",
            sessionId: "sess-1",
            commentId: "comment-1",
            state: "claimed",
            leaseExpired: false,
            claimedByUserId: "user-b",
            claimedByDisplayName: null,
            createdByUserId: "user-a",
            attempt: 1,
            forkSessionId: null,
            instruction: null,
            progress: null,
            result: null,
            errorCode: null,
            createdAt: "2026-07-07T10:00:00.000Z",
            updatedAt: "2026-07-07T10:01:00.000Z",
            // The embed never carries it (invariant 1) — but even a
            // misbehaving backend gets stripped structurally by zod.
            lease_token: "must-never-surface",
          },
        ],
      })
    );
    const { comments, tasks } = await listSessionComments(
      "jwt-1",
      "org-1",
      "sess-1"
    );
    expect(comments[0].kind).toBe("agent_report");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].commentId).toBe("comment-1");
    expect(tasks[0].state).toBe("claimed");
    expect(tasks[0].claimedByDisplayName).toBeUndefined();
    // Structural lease-token strip: no key survives parsing.
    expect(Object.keys(tasks[0])).not.toContain("lease_token");
    expect(Object.keys(tasks[0])).not.toContain("leaseToken");
  });

  it("maps ORG2_RETENTION_EXPIRED into a coded error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_RETENTION_EXPIRED" }, 400)
    );
    const error = await listSessionComments("jwt-1", "org-1", "sess-1").catch(
      (caught: unknown) => caught
    );
    expect(isOrg2CommentErrorCode(error, "ORG2_RETENTION_EXPIRED")).toBe(true);
  });
});

describe("Org2CloudCommentError code extraction", () => {
  it("matches whole tokens only", () => {
    expect(new Org2CloudCommentError("ORG2_VALIDATION").code).toBe(
      "ORG2_VALIDATION"
    );
    // A longer unknown code must not be mis-mapped to a listed prefix.
    expect(new Org2CloudCommentError("ORG2_NOT_FOUND_DETAIL").code).toBeNull();
    expect(new Org2CloudCommentError("plain failure").code).toBeNull();
  });

  it("finds the code inside a larger message", () => {
    expect(
      new Org2CloudCommentError("rpc failed: ORG2_SESSION_NOT_FOUND (410)").code
    ).toBe("ORG2_SESSION_NOT_FOUND");
  });
});
