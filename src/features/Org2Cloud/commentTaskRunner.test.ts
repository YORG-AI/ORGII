import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AddressRoundResult } from "./addressCommentsRun";
import {
  buildDefaultCommentTaskRunnerDeps,
  runInPlaceCommentTask,
} from "./commentTaskRunner";
import type { CommentTaskRunnerDeps } from "./commentTaskRunner";
import {
  Org2CloudTaskError,
  claimCommentTask,
  releaseCommentTask,
} from "./org2CloudCommentTasksClient";
import type {
  CloudCommentTask,
  CompleteCommentTaskInput,
  CompleteCommentTaskResult,
  HeartbeatCommentTaskInput,
} from "./org2CloudCommentTasksClient";
import type { CloudSessionComment } from "./org2CloudCommentsClient";

// The runner is exercised ONLY through its injected deps seam (design §5) —
// these mocks exist so importing the module never loads the heavy real
// implementations (SessionService / fork relay / event store) into the test.
vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: { sendMessage: vi.fn(), getStatus: vi.fn() },
}));
vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { getPersistedEvents: vi.fn(async () => []) },
}));
vi.mock("@src/engines/SessionCore/storage/sqliteCache", () => ({
  getSessionMetadata: vi.fn(async () => null),
}));
vi.mock("@src/features/TeamCollaboration/forkSession", () => ({
  forkTeammateSession: vi.fn(),
  resolveForkWorkspacePath: vi.fn(),
}));

const ORG_ID = "org-1";
const TASK_ID = "task-1";
const SOURCE_SESSION_ID = "agentsession-src-1";
const FORK_ID = "agentsession-fork-1";
const LEASE_TOKEN = "lease-token-fencing-credential-1";

function comment(
  overrides: Partial<CloudSessionComment> & Pick<CloudSessionComment, "id">
): CloudSessionComment {
  return {
    authorUserId: "user-1",
    authorDisplayName: "Alice",
    body: `body of ${overrides.id}`,
    createdAt: "2026-07-08T09:00:00Z",
    ...overrides,
  };
}

const REPORT_COMMENT = comment({
  id: "c-report",
  parentId: "c-head",
  body: "Fixed the migration and reran the suite.",
  kind: "agent_report",
});

function taskFixture(
  overrides: Partial<CloudCommentTask> = {}
): CloudCommentTask {
  return {
    id: TASK_ID,
    sessionId: SOURCE_SESSION_ID,
    commentId: "c-head",
    state: "open",
    leaseExpired: false,
    attempt: 0,
    instruction: "prefer a minimal patch",
    createdAt: "2026-07-08T09:00:00Z",
    updatedAt: "2026-07-08T09:00:00Z",
    ...overrides,
  };
}

function buildDeps() {
  return {
    withFreshToken: vi.fn(async () => "jwt-fresh"),
    claimCommentTask: vi.fn(async () => ({
      task: taskFixture({ state: "claimed", attempt: 1 }),
      leaseToken: LEASE_TOKEN,
      attempt: 1,
      leaseExpiresAt: "2026-07-08T09:15:00Z",
    })),
    startCommentTask: vi.fn(async () => ({
      ok: true,
      leaseExpiresAt: "2026-07-08T09:30:00Z",
    })),
    heartbeatCommentTask: vi.fn(
      async (_accessToken: string, _input: HeartbeatCommentTaskInput) => ({
        ok: true,
        leaseExpiresAt: "2026-07-08T09:45:00Z",
      })
    ),
    completeCommentTask: vi.fn(
      async (
        _accessToken: string,
        _input: CompleteCommentTaskInput
      ): Promise<CompleteCommentTaskResult> => ({
        ok: true,
        reportComment: REPORT_COMMENT,
      })
    ),
    releaseCommentTask: vi.fn(async () => ({ ok: true })),
    countSessionEvents: vi.fn(async (): Promise<number | undefined> => 20),
    onReportComment: vi.fn(),
    onStateChange: vi.fn(),
    setInterval: vi.fn((handler: () => void, ms: number) =>
      setInterval(handler, ms)
    ),
    clearInterval: vi.fn((handle: unknown) =>
      clearInterval(handle as ReturnType<typeof setInterval>)
    ),
    now: vi.fn(() => Date.now()),
  } satisfies CommentTaskRunnerDeps;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildDefaultCommentTaskRunnerDeps", () => {
  it("wires the real RPC wrappers and the caller's UI hooks", () => {
    const onReportComment = vi.fn();
    const onStateChange = vi.fn();
    const deps = buildDefaultCommentTaskRunnerDeps({
      onReportComment,
      onStateChange,
    });

    expect(deps.claimCommentTask).toBe(claimCommentTask);
    expect(deps.releaseCommentTask).toBe(releaseCommentTask);
    expect(deps.onReportComment).toBe(onReportComment);
    expect(deps.onStateChange).toBe(onStateChange);
    expect(typeof deps.withFreshToken).toBe("function");
    expect(typeof deps.setInterval).toBe("function");
    expect(typeof deps.clearInterval).toBe("function");
  });

  it("counts heartbeat events from the cheap SQLite metadata row, never the full transcript", async () => {
    const deps = buildDefaultCommentTaskRunnerDeps({
      onReportComment: vi.fn(),
    });
    const metadataMock = vi.mocked(
      (await import("@src/engines/SessionCore/storage/sqliteCache"))
        .getSessionMetadata
    );
    metadataMock.mockResolvedValueOnce({
      sessionId: FORK_ID,
      eventCount: 321,
      cachedAt: 1,
    });

    await expect(deps.countSessionEvents(FORK_ID)).resolves.toBe(321);
    // No metadata row (evicted / never persisted) degrades to undefined —
    // the heartbeat's count is cosmetic and must not fall back to a full
    // getPersistedEvents read.
    metadataMock.mockResolvedValueOnce(null);
    await expect(deps.countSessionEvents(FORK_ID)).resolves.toBeUndefined();
    const { eventStoreProxy } =
      await import("@src/engines/SessionCore/core/store/EventStoreProxy");
    expect(
      vi.mocked(eventStoreProxy.getPersistedEvents)
    ).not.toHaveBeenCalled();
  });
});

describe("in-place run (locally owned writable session)", () => {
  function buildInPlaceDeps() {
    return {
      ...buildDeps(),
      resolveLocalWritableSessionId: vi.fn(
        (sessionId: string): string | null => sessionId
      ),
      runAddressRound: vi.fn(
        async (): Promise<AddressRoundResult> => ({
          status: "ran",
          threadCount: 2,
          replyCount: 2,
          summary: "Addressed both threads.",
        })
      ),
    };
  }

  it("runs the round in place and completes with the posted-replies summary", async () => {
    const deps = buildInPlaceDeps();

    const outcome = await runInPlaceCommentTask(
      { orgId: ORG_ID, task: taskFixture(), localSessionId: SOURCE_SESSION_ID },
      deps
    );

    expect(outcome).toMatchObject({
      kind: "completed",
      ok: true,
      forkSessionId: SOURCE_SESSION_ID,
      summary:
        "Addressed 2 comment thread(s) in place; posted 2 replies below.",
    });
    expect(deps.startCommentTask).toHaveBeenCalledWith(
      "jwt-fresh",
      ORG_ID,
      TASK_ID,
      LEASE_TOKEN,
      SOURCE_SESSION_ID
    );
    expect(deps.runAddressRound).toHaveBeenCalledWith({
      orgId: ORG_ID,
      cloudSessionId: SOURCE_SESSION_ID,
      localSessionId: SOURCE_SESSION_ID,
      holdReplyForCommentId: taskFixture().commentId,
    });
    expect(deps.completeCommentTask).toHaveBeenCalledWith(
      "jwt-fresh",
      expect.objectContaining({
        ok: true,
        leaseToken: LEASE_TOKEN,
        reportBody:
          "Addressed 2 comment thread(s) in place; posted 2 replies below.",
      })
    );
    expect(deps.onReportComment).toHaveBeenCalledWith(REPORT_COMMENT);
  });

  it("reports the task thread's HELD parsed reply as the completion body (dedupe)", async () => {
    const deps = buildInPlaceDeps();
    deps.runAddressRound.mockResolvedValueOnce({
      status: "ran",
      threadCount: 2,
      replyCount: 1,
      summary: "Round summary.",
      heldReply: "Fixed the null check on the task's own thread.",
    });

    const outcome = await runInPlaceCommentTask(
      { orgId: ORG_ID, task: taskFixture(), localSessionId: SOURCE_SESSION_ID },
      deps
    );

    expect(outcome).toMatchObject({
      kind: "completed",
      ok: true,
      summary: "Fixed the null check on the task's own thread.",
    });
    expect(deps.completeCommentTask).toHaveBeenCalledWith(
      "jwt-fresh",
      expect.objectContaining({
        reportBody: "Fixed the null check on the task's own thread.",
      })
    );
  });

  it("aborts with 'already_claimed' on claim ORG2_CONFLICT before the round", async () => {
    const deps = buildInPlaceDeps();
    deps.claimCommentTask.mockRejectedValueOnce(
      new Org2CloudTaskError("ORG2_CONFLICT: task has a live holder")
    );

    const outcome = await runInPlaceCommentTask(
      { orgId: ORG_ID, task: taskFixture(), localSessionId: SOURCE_SESSION_ID },
      deps
    );

    expect(outcome).toEqual({ kind: "already_claimed" });
    expect(deps.runAddressRound).not.toHaveBeenCalled();
    expect(deps.completeCommentTask).not.toHaveBeenCalled();
    expect(deps.releaseCommentTask).not.toHaveBeenCalled();
  });

  it("completes ok:false with errorKind 'run_failed' when the round throws", async () => {
    const deps = buildInPlaceDeps();
    deps.runAddressRound.mockRejectedValueOnce(new Error("round exploded"));

    const outcome = await runInPlaceCommentTask(
      { orgId: ORG_ID, task: taskFixture(), localSessionId: SOURCE_SESSION_ID },
      deps
    );

    expect(outcome).toMatchObject({
      kind: "failed",
      errorKind: "run_failed",
      forkSessionId: SOURCE_SESSION_ID,
      reported: true,
    });
    expect(deps.completeCommentTask).toHaveBeenCalledWith(
      "jwt-fresh",
      expect.objectContaining({ ok: false, leaseToken: LEASE_TOKEN })
    );
    expect(deps.clearInterval).toHaveBeenCalled();
  });

  it("releases the claim and resolves 'cancelled' when another round already drives the session", async () => {
    const deps = buildInPlaceDeps();
    deps.runAddressRound.mockResolvedValueOnce({ status: "skipped_active" });

    const outcome = await runInPlaceCommentTask(
      { orgId: ORG_ID, task: taskFixture(), localSessionId: SOURCE_SESSION_ID },
      deps
    );

    expect(outcome).toEqual({
      kind: "cancelled",
      forkSessionId: SOURCE_SESSION_ID,
    });
    expect(deps.releaseCommentTask).toHaveBeenCalledWith(
      "jwt-fresh",
      ORG_ID,
      TASK_ID,
      LEASE_TOKEN
    );
    expect(deps.completeCommentTask).not.toHaveBeenCalled();
  });

  it("stops reporting on start ORG2_CONFLICT (lease lost)", async () => {
    const deps = buildInPlaceDeps();
    deps.startCommentTask.mockRejectedValueOnce(
      new Org2CloudTaskError("ORG2_CONFLICT: lease stolen")
    );

    const outcome = await runInPlaceCommentTask(
      { orgId: ORG_ID, task: taskFixture(), localSessionId: SOURCE_SESSION_ID },
      deps
    );

    expect(outcome).toEqual({
      kind: "lease_lost",
      forkSessionId: SOURCE_SESSION_ID,
    });
    expect(deps.runAddressRound).not.toHaveBeenCalled();
    expect(deps.completeCommentTask).not.toHaveBeenCalled();
  });
});
