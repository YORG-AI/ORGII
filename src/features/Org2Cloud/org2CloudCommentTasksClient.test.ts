import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import {
  CLOUD_TASK_HEARTBEAT_MS,
  CLOUD_TASK_LEASE_SECONDS,
  CLOUD_TASK_MAX_ATTEMPTS,
  CLOUD_TASK_PROGRESS_MAX_CHARS,
  Org2CloudTaskError,
  claimCommentTask,
  completeCommentTask,
  createCommentTask,
  heartbeatCommentTask,
  isOrg2TaskErrorCode,
  listCommentTasks,
  releaseCommentTask,
  startCommentTask,
} from "./org2CloudCommentTasksClient";

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

// comment_task_wire shape, exactly as the 0002 migration builds it.
const WIRE_TASK = {
  id: "task-1",
  sessionId: "sess-1",
  commentId: "comment-1",
  state: "open",
  leaseExpired: false,
  claimedByUserId: null,
  claimedByDisplayName: null,
  createdByUserId: "user-a",
  attempt: 0,
  forkSessionId: null,
  instruction: null,
  progress: null,
  result: null,
  errorCode: null,
  createdAt: "2026-07-07T10:00:00.000Z",
  updatedAt: "2026-07-07T10:00:00.000Z",
};

const LEASE_EXPIRES_AT = "2026-07-07T10:15:00.000Z";

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(jsonResponse(null));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("protocol constants", () => {
  it("pins the documented lease/heartbeat/progress/attempt bounds", () => {
    expect(CLOUD_TASK_LEASE_SECONDS).toBe(900);
    expect(CLOUD_TASK_HEARTBEAT_MS).toBe(60_000);
    expect(CLOUD_TASK_PROGRESS_MAX_CHARS).toBe(4000);
    expect(CLOUD_TASK_MAX_ATTEMPTS).toBe(3);
  });
});

describe("createCommentTask", () => {
  it("posts p_instruction=null by default and parses {task, created}", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: WIRE_TASK, created: true })
    );
    const result = await createCommentTask("jwt-1", {
      orgId: "org-1",
      commentId: "comment-1",
    });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_comment_id: "comment-1",
      p_instruction: null,
    });
    expect(result.created).toBe(true);
    expect(result.task.id).toBe("task-1");
    expect(result.task.state).toBe("open");
    // Nullish wire fields normalize to undefined (protocol.ts idiom).
    expect(result.task.claimedByUserId).toBeUndefined();
    expect(result.task.forkSessionId).toBeUndefined();
    expect(result.task.instruction).toBeUndefined();
    expect(result.task.progress).toBeUndefined();
    expect(result.task.result).toBeUndefined();
    expect(result.task.errorCode).toBeUndefined();
  });

  it("sends the optional instruction and reports the idempotent re-create", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        task: { ...WIRE_TASK, instruction: "fix the failing turn" },
        created: false,
      })
    );
    const result = await createCommentTask("jwt-1", {
      orgId: "org-1",
      commentId: "comment-1",
      instruction: "fix the failing turn",
    });
    expect(lastBody().p_instruction).toBe("fix the failing turn");
    expect(result.created).toBe(false);
    expect(result.task.instruction).toBe("fix the failing turn");
  });

  it("sends JWT bearer + Content-Profile", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ task: WIRE_TASK, created: true })
    );
    await createCommentTask("jwt-9", { orgId: "org-1", commentId: "c-1" });
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_create_comment_task`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-9");
    expect(headers["content-profile"]).toBe(ORG2_CLOUD_POSTGREST_SCHEMA);
  });

  it("maps ORG2_QUOTA_EXCEEDED (org-wide 200 live-task cap — create only)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_QUOTA_EXCEEDED" }, 400)
    );
    const error = await createCommentTask("jwt-1", {
      orgId: "org-1",
      commentId: "comment-1",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudTaskError);
    expect(isOrg2TaskErrorCode(error, "ORG2_QUOTA_EXCEEDED")).toBe(true);
  });
});

describe("claimCommentTask", () => {
  it("posts the default 900s lease and surfaces the fencing token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        task: {
          ...WIRE_TASK,
          state: "claimed",
          claimedByUserId: "user-b",
          claimedByDisplayName: "Bob",
          attempt: 1,
        },
        leaseToken: "lease-token-1",
        attempt: 1,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      })
    );
    const result = await claimCommentTask("jwt-1", "org-1", "task-1");
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_task_id: "task-1",
      p_lease_seconds: CLOUD_TASK_LEASE_SECONDS,
    });
    expect(result.leaseToken).toBe("lease-token-1");
    expect(result.attempt).toBe(1);
    expect(result.leaseExpiresAt).toBe(LEASE_EXPIRES_AT);
    expect(result.task.state).toBe("claimed");
    expect(result.task.claimedByDisplayName).toBe("Bob");
  });

  it("passes a custom lease duration (server clamps 60..3600)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        task: { ...WIRE_TASK, state: "claimed", attempt: 1 },
        leaseToken: "lease-token-2",
        attempt: 1,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      })
    );
    await claimCommentTask("jwt-1", "org-1", "task-1", 1800);
    expect(lastBody().p_lease_seconds).toBe(1800);
  });

  it("maps ORG2_CONFLICT (live holder or attempt cap — no identity leaked)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_CONFLICT" }, 400)
    );
    const error = await claimCommentTask("jwt-1", "org-1", "task-1").catch(
      (caught: unknown) => caught
    );
    expect(isOrg2TaskErrorCode(error, "ORG2_CONFLICT")).toBe(true);
  });

  it("maps ORG2_RETENTION_EXPIRED (aged session — upgrade deep-link path)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_RETENTION_EXPIRED" }, 400)
    );
    const error = await claimCommentTask("jwt-1", "org-1", "task-1").catch(
      (caught: unknown) => caught
    );
    expect(isOrg2TaskErrorCode(error, "ORG2_RETENTION_EXPIRED")).toBe(true);
  });
});

describe("startCommentTask", () => {
  it("posts the token-fenced fork id and returns the renewed lease", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, leaseExpiresAt: LEASE_EXPIRES_AT })
    );
    const result = await startCommentTask(
      "jwt-1",
      "org-1",
      "task-1",
      "lease-token-1",
      "agentsession-fork-1"
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_task_id: "task-1",
      p_lease_token: "lease-token-1",
      p_fork_session_id: "agentsession-fork-1",
    });
    expect(result).toEqual({ ok: true, leaseExpiresAt: LEASE_EXPIRES_AT });
  });

  it("maps ORG2_CONFLICT (lease lost — stop coordination writes)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_CONFLICT" }, 400)
    );
    const error = await startCommentTask(
      "jwt-1",
      "org-1",
      "task-1",
      "stale-token",
      "agentsession-fork-1"
    ).catch((caught: unknown) => caught);
    expect(isOrg2TaskErrorCode(error, "ORG2_CONFLICT")).toBe(true);
  });
});

describe("heartbeatCommentTask", () => {
  it("renews without progress: p_progress=null, default lease seconds", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, leaseExpiresAt: LEASE_EXPIRES_AT })
    );
    const result = await heartbeatCommentTask("jwt-1", {
      orgId: "org-1",
      taskId: "task-1",
      leaseToken: "lease-token-1",
    });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_task_id: "task-1",
      p_lease_token: "lease-token-1",
      p_progress: null,
      p_lease_seconds: CLOUD_TASK_LEASE_SECONDS,
    });
    expect(result.leaseExpiresAt).toBe(LEASE_EXPIRES_AT);
  });

  it("passes the opaque progress payload verbatim", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, leaseExpiresAt: LEASE_EXPIRES_AT })
    );
    await heartbeatCommentTask("jwt-1", {
      orgId: "org-1",
      taskId: "task-1",
      leaseToken: "lease-token-1",
      progress: { phase: "running", eventCount: 12 },
      leaseSeconds: 600,
    });
    expect(lastBody().p_progress).toEqual({
      phase: "running",
      eventCount: 12,
    });
    expect(lastBody().p_lease_seconds).toBe(600);
  });

  it("maps ORG2_CONFLICT (fenced out by a steal)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_CONFLICT" }, 400)
    );
    const error = await heartbeatCommentTask("jwt-1", {
      orgId: "org-1",
      taskId: "task-1",
      leaseToken: "stale-token",
    }).catch((caught: unknown) => caught);
    expect(isOrg2TaskErrorCode(error, "ORG2_CONFLICT")).toBe(true);
  });
});

describe("completeCommentTask", () => {
  it("posts the full arg set and parses the agent report comment", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        reportComment: {
          id: "comment-9",
          eventId: null,
          parentId: "comment-1",
          authorUserId: "user-b",
          authorDisplayName: "Bob",
          body: "done — see the fork",
          createdAt: "2026-07-07T12:00:00.000Z",
          editedAt: null,
          deletedAt: null,
          resolvedAt: null,
          kind: "agent_report",
        },
      })
    );
    const result = await completeCommentTask("jwt-1", {
      orgId: "org-1",
      taskId: "task-1",
      leaseToken: "lease-token-1",
      ok: true,
      result: { ok: true, summary: "patched", eventCount: 12 },
      reportBody: "done — see the fork",
    });
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_task_id: "task-1",
      p_lease_token: "lease-token-1",
      p_ok: true,
      p_result: { ok: true, summary: "patched", eventCount: 12 },
      p_report_body: "done — see the fork",
    });
    expect(result.ok).toBe(true);
    expect(result.reportComment?.id).toBe("comment-9");
    expect(result.reportComment?.parentId).toBe("comment-1");
    // Nullish wire fields normalize to undefined (protocol.ts idiom).
    expect(result.reportComment?.eventId).toBeUndefined();
    expect(result.reportSkipped).toBeUndefined();
  });

  it("omits the report: p_report_body=null, bare {ok:true} return", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await completeCommentTask("jwt-1", {
      orgId: "org-1",
      taskId: "task-1",
      leaseToken: "lease-token-1",
      ok: false,
      result: { ok: false, errorKind: "fork_failed" },
    });
    expect(lastBody().p_ok).toBe(false);
    expect(lastBody().p_report_body).toBeNull();
    expect(result.reportComment).toBeUndefined();
    expect(result.reportSkipped).toBeUndefined();
  });

  it("passes reportSkipped through (task completed despite the cap)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, reportSkipped: "quota" })
    );
    const result = await completeCommentTask("jwt-1", {
      orgId: "org-1",
      taskId: "task-1",
      leaseToken: "lease-token-1",
      ok: true,
      result: { ok: true, summary: "patched" },
      reportBody: "done",
    });
    expect(result.ok).toBe(true);
    expect(result.reportSkipped).toBe("quota");
    expect(result.reportComment).toBeUndefined();
  });
});

describe("releaseCommentTask", () => {
  it("posts the fenced release (a stale token is a server-side no-op)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await releaseCommentTask(
      "jwt-1",
      "org-1",
      "task-1",
      "lease-token-1"
    );
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_task_id: "task-1",
      p_lease_token: "lease-token-1",
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("listCommentTasks", () => {
  it("posts p_since=null for the full listing and normalizes entries", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        serverTime: "2026-07-07T10:20:00.000Z",
        tasks: [
          WIRE_TASK,
          {
            ...WIRE_TASK,
            id: "task-2",
            state: "running",
            leaseExpired: true,
            claimedByUserId: "user-b",
            // Missing profile: LEFT JOIN yields null, never a dropped row.
            claimedByDisplayName: null,
            attempt: 2,
            forkSessionId: "agentsession-fork-1",
            progress: { phase: "running", eventCount: 7 },
          },
        ],
      })
    );
    const result = await listCommentTasks("jwt-1", "org-1", null);
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_since: null });
    expect(result.serverTime).toBe("2026-07-07T10:20:00.000Z");
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].claimedByUserId).toBeUndefined();
    expect(result.tasks[1].leaseExpired).toBe(true);
    expect(result.tasks[1].claimedByUserId).toBe("user-b");
    expect(result.tasks[1].claimedByDisplayName).toBeUndefined();
    expect(result.tasks[1].progress).toEqual({
      phase: "running",
      eventCount: 7,
    });
  });

  it("posts the ISO delta cursor", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ serverTime: "2026-07-07T10:21:00.000Z", tasks: [] })
    );
    await listCommentTasks("jwt-1", "org-1", "2026-07-07T10:19:58.000Z");
    expect(lastBody().p_since).toBe("2026-07-07T10:19:58.000Z");
  });

  it("defaults an absent tasks array to []", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ serverTime: "2026-07-07T10:22:00.000Z" })
    );
    const result = await listCommentTasks("jwt-1", "org-1", null);
    expect(result.tasks).toEqual([]);
  });
});

describe("Org2CloudTaskError code extraction", () => {
  it("matches whole tokens only", () => {
    expect(new Org2CloudTaskError("ORG2_CONFLICT").code).toBe("ORG2_CONFLICT");
    // A longer unknown code that CONTAINS a listed one must not be
    // mis-mapped (whole-token discipline).
    expect(new Org2CloudTaskError("ORG2_CONFLICT_RETRY_LATER").code).toBeNull();
    expect(new Org2CloudTaskError("ORG2_NOT_FOUND_DETAIL").code).toBeNull();
    expect(new Org2CloudTaskError("plain failure").code).toBeNull();
  });

  it("finds the code inside a larger message", () => {
    expect(
      new Org2CloudTaskError("rpc failed: ORG2_RETENTION_EXPIRED (410)").code
    ).toBe("ORG2_RETENTION_EXPIRED");
  });

  it("isOrg2TaskErrorCode rejects foreign error shapes", () => {
    expect(
      isOrg2TaskErrorCode(new Error("ORG2_CONFLICT"), "ORG2_CONFLICT")
    ).toBe(false);
  });
});

// Invariant 1: the claim envelope is the ONLY carrier of a lease token.
// Every other wrapper is fed a hostile payload that smuggles token keys at
// the top level AND inside the task rows — the zod wire schemas must strip
// them all, so nothing token-shaped can ever reach atoms or render code.
describe("lease-token confinement", () => {
  const POISONED_TASK = {
    ...WIRE_TASK,
    lease_token: "leaked-raw",
    leaseToken: "leaked-camel",
  };

  const NON_CLAIM_WRAPPERS: Array<{
    name: string;
    response: unknown;
    run: () => Promise<unknown>;
  }> = [
    {
      name: "createCommentTask",
      response: { task: POISONED_TASK, created: true, leaseToken: "leaked" },
      run: () =>
        createCommentTask("jwt-1", { orgId: "org-1", commentId: "comment-1" }),
    },
    {
      name: "startCommentTask",
      response: {
        ok: true,
        leaseExpiresAt: LEASE_EXPIRES_AT,
        leaseToken: "leaked",
      },
      run: () =>
        startCommentTask(
          "jwt-1",
          "org-1",
          "task-1",
          "lease-token-1",
          "agentsession-fork-1"
        ),
    },
    {
      name: "heartbeatCommentTask",
      response: {
        ok: true,
        leaseExpiresAt: LEASE_EXPIRES_AT,
        leaseToken: "leaked",
      },
      run: () =>
        heartbeatCommentTask("jwt-1", {
          orgId: "org-1",
          taskId: "task-1",
          leaseToken: "lease-token-1",
        }),
    },
    {
      name: "completeCommentTask",
      response: { ok: true, reportSkipped: "quota", leaseToken: "leaked" },
      run: () =>
        completeCommentTask("jwt-1", {
          orgId: "org-1",
          taskId: "task-1",
          leaseToken: "lease-token-1",
          ok: true,
          result: { ok: true },
        }),
    },
    {
      name: "releaseCommentTask",
      response: { ok: true, leaseToken: "leaked" },
      run: () =>
        releaseCommentTask("jwt-1", "org-1", "task-1", "lease-token-1"),
    },
    {
      name: "listCommentTasks",
      response: {
        serverTime: LEASE_EXPIRES_AT,
        tasks: [POISONED_TASK],
        leaseToken: "leaked",
      },
      run: () => listCommentTasks("jwt-1", "org-1", null),
    },
  ];

  it.each(NON_CLAIM_WRAPPERS)(
    "$name never surfaces a lease token",
    async ({ response, run }) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(response));
      const result = await run();
      expect(JSON.stringify(result)).not.toMatch(/lease_?token/i);
    }
  );

  it("claimCommentTask is the ONLY carrier — and only on its envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        task: POISONED_TASK,
        leaseToken: "lease-token-1",
        attempt: 1,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      })
    );
    const result = await claimCommentTask("jwt-1", "org-1", "task-1");
    expect(result.leaseToken).toBe("lease-token-1");
    // The embedded task wire still strips smuggled token keys.
    expect(JSON.stringify(result.task)).not.toMatch(/lease_?token/i);
  });
});
