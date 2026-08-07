import { describe, expect, it } from "vitest";

import type { CloudCommentTask } from "../org2CloudCommentTasksClient";
import type { CloudSessionComment } from "../org2CloudCommentsClient";
import type { CommentThread } from "../org2CloudSessionCommentsAtom";
import {
  AGENT_COMPOSER_PREFIX,
  detectAgentPrefix,
  isLiveTaskState,
  splitAgentMentionBody,
  threadsHaveLiveAgentTask,
} from "./commentAgentAffordances";

function comment(id: string): CloudSessionComment {
  return {
    id,
    authorUserId: "user-1",
    body: "b",
    createdAt: "2026-07-08T09:00:00Z",
  };
}

function thread(headId: string, replyIds: string[] = []): CommentThread {
  return { top: comment(headId), replies: replyIds.map(comment) };
}

function task(overrides: Partial<CloudCommentTask> = {}): CloudCommentTask {
  return {
    id: "task-1",
    sessionId: "agentsession-src-1",
    commentId: "c-head",
    state: "open",
    leaseExpired: false,
    attempt: 0,
    createdAt: "2026-07-08T09:00:00Z",
    updatedAt: "2026-07-08T09:00:00Z",
    ...overrides,
  };
}

/** Map-backed stand-in for the context's `taskForThread` selector. */
function lookup(
  byCommentId: Record<string, CloudCommentTask>
): (commentId: string) => CloudCommentTask | undefined {
  return (commentId) => byCommentId[commentId];
}

describe("detectAgentPrefix — literal, deterministic (design §1: no NL)", () => {
  it("matches the exact prefix followed by content", () => {
    expect(detectAgentPrefix("@agent fix the null check")).toBe(true);
    expect(detectAgentPrefix("@agent  double space still counts")).toBe(true);
  });

  it("the trailing space is part of the token", () => {
    expect(detectAgentPrefix("@agent")).toBe(false);
    expect(detectAgentPrefix("@agents please")).toBe(false);
    expect(detectAgentPrefix("@agent.")).toBe(false);
  });

  it("requires content after the prefix (comments post VERBATIM)", () => {
    expect(detectAgentPrefix("@agent ")).toBe(false);
    expect(detectAgentPrefix("@agent   ")).toBe(false);
  });

  it("is case-sensitive and anchored at index 0", () => {
    expect(detectAgentPrefix("@Agent fix")).toBe(false);
    expect(detectAgentPrefix("hey @agent fix")).toBe(false);
    // Composers trim before submit; the raw detector stays literal.
    expect(detectAgentPrefix(" @agent fix")).toBe(false);
  });

  it("exports the literal token the composer placeholder documents", () => {
    expect(AGENT_COMPOSER_PREFIX).toBe("@agent ");
  });
});

describe("splitAgentMentionBody — rendered mention token", () => {
  it("returns the canonical pill label and preserves the submitted brief", () => {
    expect(splitAgentMentionBody("@agent fix the null check")).toEqual({
      mention: "@agent",
      brief: "fix the null check",
    });
    expect(splitAgentMentionBody("@agent  preserve spacing")).toEqual({
      mention: "@agent",
      brief: " preserve spacing",
    });
  });

  it("does not tokenize ordinary inline or incomplete text", () => {
    expect(splitAgentMentionBody("hello @agent fix this")).toBeNull();
    expect(splitAgentMentionBody("@agent ")).toBeNull();
  });
});

describe("isLiveTaskState — open/claimed/running (design §4 item 3)", () => {
  it("open, claimed and running are live", () => {
    expect(isLiveTaskState("open")).toBe(true);
    expect(isLiveTaskState("claimed")).toBe(true);
    expect(isLiveTaskState("running")).toBe(true);
  });

  it("terminal states are not", () => {
    expect(isLiveTaskState("done")).toBe(false);
    expect(isLiveTaskState("failed")).toBe(false);
  });
});

describe("threadsHaveLiveAgentTask — turn badge predicate", () => {
  it("false with no threads or no tasks", () => {
    expect(threadsHaveLiveAgentTask([], lookup({}))).toBe(false);
    expect(threadsHaveLiveAgentTask([thread("c-1")], lookup({}))).toBe(false);
  });

  it("true when ANY thread's head carries a live task", () => {
    const threads = [thread("c-1"), thread("c-2"), thread("c-3")];
    expect(
      threadsHaveLiveAgentTask(
        threads,
        lookup({ "c-2": task({ commentId: "c-2", state: "claimed" }) })
      )
    ).toBe(true);
  });

  it("lease-expired claimed/running still counts (state is still live)", () => {
    expect(
      threadsHaveLiveAgentTask(
        [thread("c-1")],
        lookup({
          "c-1": task({
            commentId: "c-1",
            state: "running",
            leaseExpired: true,
          }),
        })
      )
    ).toBe(true);
  });

  it("terminal tasks never light the badge", () => {
    for (const state of ["done", "failed"] as const) {
      expect(
        threadsHaveLiveAgentTask(
          [thread("c-1")],
          lookup({ "c-1": task({ commentId: "c-1", state }) })
        )
      ).toBe(false);
    }
  });

  it("looks up thread HEADS only (replies are never promoted)", () => {
    expect(
      threadsHaveLiveAgentTask(
        [thread("c-1", ["r-1"])],
        lookup({ "r-1": task({ commentId: "r-1" }) })
      )
    ).toBe(false);
  });
});
