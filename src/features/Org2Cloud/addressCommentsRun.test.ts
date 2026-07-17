import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { resolveTrustedDispatchParams } from "@src/engines/SessionCore/hooks/adeReplyBinding";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import {
  createInstrumentedStore,
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import type { AddressableThread } from "./addressComments";
import type { ActiveAddressRun } from "./addressCommentsRun";
import {
  attachAnchorExcerpts,
  partitionAddressReplies,
  replyViaActiveAddressRun,
  runAddressCommentsRound,
  seedActiveAddressRunForTest,
  selectFallbackReplies,
} from "./addressCommentsRun";
import { agentTaskRunnerSettingsAtom } from "./agentTaskRunnerSettingsAtom";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { listSessionComments } from "./org2CloudCommentsClient";
import type { CloudSessionComment } from "./org2CloudCommentsClient";

vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: { sendMessage: vi.fn(), getStatus: vi.fn() },
}));
vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { getPersistedEvents: vi.fn(async () => []) },
}));
vi.mock("./org2CloudClient", () => ({
  ensureFreshSession: vi.fn(async (state: unknown) => state),
}));
vi.mock("./org2CloudCommentsClient", () => ({
  listSessionComments: vi.fn(),
  addSessionComment: vi.fn(async () => undefined),
}));
vi.mock("./org2CloudCommentsBus", () => ({
  broadcastCommentsChanged: vi.fn(),
}));

function thread(
  overrides: Partial<AddressableThread> & Pick<AddressableThread, "headId">
): AddressableThread {
  return {
    headAuthor: "Alice",
    headBody: `body of ${overrides.headId}`,
    replies: [],
    scope: "session",
    ...overrides,
  };
}

function comment(
  overrides: Partial<CloudSessionComment> & Pick<CloudSessionComment, "id">
): CloudSessionComment {
  return {
    authorUserId: "user-1",
    authorDisplayName: "Alice",
    body: `body of ${overrides.id}`,
    createdAt: "2026-07-11T09:00:00Z",
    ...overrides,
  };
}

describe("attachAnchorExcerpts", () => {
  it("copies the anchor event's display text onto anchored threads only", () => {
    const threads = [
      thread({ headId: "c-1", scope: "round", anchorEventId: "evt-1" }),
      thread({ headId: "c-2" }),
    ];
    const events = [
      { id: "evt-1", displayText: "The agent ran the migration here." },
      { id: "evt-2", displayText: "Unrelated turn." },
    ];

    const result = attachAnchorExcerpts(threads, events);

    expect(result[0].anchorExcerpt).toBe("The agent ran the migration here.");
    expect(result[1].anchorExcerpt).toBeUndefined();
  });

  it("leaves threads untouched when the anchor event is missing or textless", () => {
    const threads = [
      thread({
        headId: "c-1",
        scope: "round",
        anchorEventId: "evt-gone",
      }),
      thread({
        headId: "c-2",
        scope: "round",
        anchorEventId: "evt-blank",
      }),
    ];
    const events = [{ id: "evt-blank", displayText: "" }];

    const result = attachAnchorExcerpts(threads, events);

    expect(result[0]).toEqual(threads[0]);
    expect(result[1]).toEqual(threads[1]);
  });

  it("never mutates its inputs", () => {
    const original = thread({
      headId: "c-1",
      scope: "round",
      anchorEventId: "evt-1",
    });
    const events = [{ id: "evt-1", displayText: "anchor text" }];

    const result = attachAnchorExcerpts([original], events);

    expect(original.anchorExcerpt).toBeUndefined();
    expect(result[0]).not.toBe(original);
  });
});

describe("partitionAddressReplies", () => {
  const replies = [
    { commentId: "c-1", body: "reply one" },
    { commentId: "c-2", body: "reply two" },
  ];

  it("holds the task thread's reply and posts the rest", () => {
    const { toPost, heldReply } = partitionAddressReplies(replies, "c-1");
    expect(toPost).toEqual([{ commentId: "c-2", body: "reply two" }]);
    expect(heldReply).toBe("reply one");
  });

  it("posts everything when no hold is requested or nothing matches", () => {
    expect(partitionAddressReplies(replies, undefined)).toEqual({
      toPost: replies,
    });
    expect(partitionAddressReplies(replies, "c-none")).toEqual({
      toPost: replies,
    });
  });

  it("holds the fallback single reply when it targets the held thread", () => {
    const fallback = [{ commentId: "c-task", body: "whole-run summary" }];
    expect(partitionAddressReplies(fallback, "c-task")).toEqual({
      toPost: [],
      heldReply: "whole-run summary",
    });
  });
});

describe("attachAnchorExcerpts round numbers", () => {
  it("attaches the anchor round number and that round's user message", () => {
    const threads = [
      thread({ headId: "c-1", scope: "round", anchorEventId: "evt-a2" }),
      thread({ headId: "c-2", scope: "round", anchorEventId: "evt-u2" }),
    ];
    const events = [
      { id: "evt-u1", displayText: "round one ask", source: "user" },
      { id: "evt-a1", displayText: "round one answer", source: "assistant" },
      { id: "evt-u2", displayText: "round two ask", source: "user" },
      { id: "evt-a2", displayText: "round two answer", source: "assistant" },
    ];

    const result = attachAnchorExcerpts(threads, events);

    expect(result[0].anchorRoundNumber).toBe(2);
    expect(result[0].anchorExcerpt).toBe("round two ask");
    expect(result[1].anchorRoundNumber).toBe(2);
    expect(result[1].anchorExcerpt).toBe("round two ask");
  });

  it("keeps the plain excerpt when events carry no source", () => {
    const threads = [
      thread({ headId: "c-1", scope: "round", anchorEventId: "evt-1" }),
    ];
    const events = [{ id: "evt-1", displayText: "anchor text" }];

    const result = attachAnchorExcerpts(threads, events);

    expect(result[0].anchorExcerpt).toBe("anchor text");
    expect(result[0].anchorRoundNumber).toBeUndefined();
  });
});

describe("selectFallbackReplies", () => {
  const validIds = new Set(["c-1", "c-2"]);

  it("keeps parsed replies only for threads not already replied via tool", () => {
    const summary = [
      "### REPLY c-1",
      "parsed one",
      "### REPLY c-2",
      "parsed two",
    ].join("\n");
    const replied = new Map([["c-1", "tool reply"]]);
    expect(selectFallbackReplies(summary, validIds, replied, "c-1")).toEqual([
      { commentId: "c-2", body: "parsed two" },
    ]);
  });

  it("falls back to a single summary reply only when nothing was replied", () => {
    expect(
      selectFallbackReplies("plain summary", validIds, new Map(), "c-1")
    ).toEqual([{ commentId: "c-1", body: "plain summary" }]);
  });

  it("returns nothing when the tool already replied and no sections parse", () => {
    const replied = new Map([["c-1", "tool reply"]]);
    expect(
      selectFallbackReplies("plain summary", validIds, replied, "c-1")
    ).toEqual([]);
  });
});

describe("replyViaActiveAddressRun", () => {
  it("rejects empty bodies and unknown comment ids", async () => {
    expect((await replyViaActiveAddressRun("c-x", "   ", "ls-1")).success).toBe(
      false
    );
    const result = await replyViaActiveAddressRun("c-unknown", "hi", "ls-1");
    expect(result.success).toBe(false);
    expect(result.message).toContain("c-unknown");
  });

  it("fails closed when no invoking session id is supplied", async () => {
    const run: ActiveAddressRun = {
      orgId: "org-1",
      cloudSessionId: "cs-1",
      localSessionId: "ls-1",
      validHeadIds: new Set(["c-open"]),
      replied: new Map<string, string>(),
    };
    const cleanup = seedActiveAddressRunForTest(run);
    try {
      const absent = await replyViaActiveAddressRun("c-open", "hi");
      expect(absent.success).toBe(false);
      expect(absent.message).toContain("no invoking session id");
      const empty = await replyViaActiveAddressRun("c-open", "hi", "");
      expect(empty.success).toBe(false);
      expect(empty.message).toContain("no invoking session id");
      expect(run.replied.has("c-open")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("records the held reply without posting and rejects duplicates", async () => {
    const run: ActiveAddressRun = {
      orgId: "org-1",
      cloudSessionId: "cs-1",
      localSessionId: "ls-1",
      validHeadIds: new Set(["c-hold"]),
      holdReplyForCommentId: "c-hold",
      replied: new Map<string, string>(),
    };
    const cleanup = seedActiveAddressRunForTest(run);
    try {
      const first = await replyViaActiveAddressRun(
        "c-hold",
        " held body ",
        "ls-1"
      );
      expect(first.success).toBe(true);
      expect(run.heldBody).toBe("held body");
      expect(run.replied.get("c-hold")).toBe("held body");

      const second = await replyViaActiveAddressRun("c-hold", "again", "ls-1");
      expect(second.success).toBe(false);
      expect(second.message).toContain("already");
    } finally {
      cleanup();
    }
  });
});

describe("replyViaActiveAddressRun cross-run isolation", () => {
  function heldRun(
    localSessionId: string,
    commentId: string
  ): ActiveAddressRun {
    return {
      orgId: "org-1",
      cloudSessionId: `cs-${localSessionId}`,
      localSessionId,
      validHeadIds: new Set([commentId]),
      holdReplyForCommentId: commentId,
      replied: new Map<string, string>(),
    };
  }

  it("rejects a reply whose invoking session does not own the target run", async () => {
    const runA = heldRun("ls-A", "a-1");
    const runB = heldRun("ls-B", "b-1");
    const cleanupA = seedActiveAddressRunForTest(runA);
    const cleanupB = seedActiveAddressRunForTest(runB);
    try {
      // Session A's agent may reply to A's own thread.
      const own = await replyViaActiveAddressRun("a-1", "done", "ls-A");
      expect(own.success).toBe(true);
      expect(runA.replied.get("a-1")).toBe("done");

      // Session A's agent must NOT reach B's thread by guessing B's id.
      const foreign = await replyViaActiveAddressRun("b-1", "forged", "ls-A");
      expect(foreign.success).toBe(false);
      expect(foreign.message).toContain("b-1");
      expect(runB.replied.has("b-1")).toBe(false);
      expect(runB.heldBody).toBeUndefined();
    } finally {
      cleanupB();
      cleanupA();
    }
  });

  it("binds the reply when the invoking session owns the run (no false reject)", async () => {
    const run = heldRun("ls-1", "c-1");
    const cleanup = seedActiveAddressRunForTest(run);
    try {
      const result = await replyViaActiveAddressRun("c-1", "ok", "ls-1");
      expect(result.success).toBe(true);
      expect(run.heldBody).toBe("ok");
    } finally {
      cleanup();
    }
  });

  it("a spoofed params.localSessionId cannot land session A's reply in session B", async () => {
    const runA = heldRun("ls-A", "a-1");
    const runB = heldRun("ls-B", "b-1");
    const cleanupA = seedActiveAddressRunForTest(runA);
    const cleanupB = seedActiveAddressRunForTest(runB);
    try {
      const spoofed = {
        commentId: "b-1",
        body: "forged",
        localSessionId: "ls-B",
      };

      const viaReplyTool = resolveTrustedDispatchParams(
        ACTION_ID.SESSION_REPLY_COMMENT,
        spoofed,
        "ls-A"
      );
      const forged = await replyViaActiveAddressRun(
        viaReplyTool.commentId as string,
        viaReplyTool.body as string,
        viaReplyTool.localSessionId as string
      );
      expect(forged.success).toBe(false);
      expect(runB.replied.has("b-1")).toBe(false);
      expect(runB.heldBody).toBeUndefined();

      const viaControlOrgii = resolveTrustedDispatchParams(
        ACTION_ID.SESSION_REPLY_COMMENT,
        spoofed,
        undefined
      );
      const rejected = await replyViaActiveAddressRun(
        viaControlOrgii.commentId as string,
        viaControlOrgii.body as string,
        viaControlOrgii.localSessionId as string
      );
      expect(rejected.success).toBe(false);
      expect(rejected.message).toContain("no invoking session id");
      expect(runB.replied.has("b-1")).toBe(false);
    } finally {
      cleanupB();
      cleanupA();
    }
  });
});

describe("runAddressCommentsRound honors per-org runner settings", () => {
  const AUTH: Org2CloudAuthState = {
    kind: "org2_cloud",
    supabaseUrl: "https://cloud.example.co",
    supabaseAnonKey: "anon",
    userId: "user-1",
    accessToken: "jwt-1",
    refreshToken: "rt-1",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  beforeEach(() => {
    if (!isStoreInitialized()) createInstrumentedStore();
    getInstrumentedStore().set(org2CloudAuthAtom, AUTH);
    vi.mocked(SessionService.getStatus).mockResolvedValue({
      status: "completed",
    } as Awaited<ReturnType<typeof SessionService.getStatus>>);
    vi.mocked(listSessionComments).mockResolvedValue({
      comments: [comment({ id: "head-1", body: "please fix the null check" })],
    } as Awaited<ReturnType<typeof listSessionComments>>);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    getInstrumentedStore().set(org2CloudAuthAtom, null);
    getInstrumentedStore().set(agentTaskRunnerSettingsAtom, {});
    vi.clearAllMocks();
  });

  it("passes the configured model / mode / account into the drive turn", async () => {
    getInstrumentedStore().set(agentTaskRunnerSettingsAtom, {
      "org-1": { model: "m-x", mode: "plan", accountId: "acc-x" },
    });

    const runPromise = runAddressCommentsRound({
      orgId: "org-1",
      cloudSessionId: "cs-1",
      localSessionId: "ls-1",
    });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await runPromise;

    expect(result.status).toBe("ran");
    expect(SessionService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ls-1",
        model: "m-x",
        mode: "plan",
        accountId: "acc-x",
      })
    );
  });

  it("defaults mode to 'build' and omits account/model when unset", async () => {
    const runPromise = runAddressCommentsRound({
      orgId: "org-1",
      cloudSessionId: "cs-1",
      localSessionId: "ls-2",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await runPromise;

    const params = vi.mocked(SessionService.sendMessage).mock.calls[0][0];
    expect(params.mode).toBe("build");
    expect("model" in params).toBe(false);
    expect("accountId" in params).toBe(false);
  });
});
