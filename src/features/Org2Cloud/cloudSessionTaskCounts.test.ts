import { describe, expect, it } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { resolveSessionTaskCounts } from "./cloudSessionTaskCounts";
import type {
  CloudCommentTask,
  CloudCommentTaskState,
} from "./org2CloudCommentTasksClient";

type CounterFields = Pick<
  RemoteTeammateSessionMetadata,
  "openAgentTaskCount" | "activeAgentTaskCount"
>;

function makeTask(
  id: string,
  state: CloudCommentTaskState,
  overrides: Partial<CloudCommentTask> = {}
): CloudCommentTask {
  return {
    id,
    sessionId: "agentsession-1",
    commentId: `comment-${id}`,
    state,
    leaseExpired: false,
    attempt: 1,
    createdAt: "2026-07-08T00:00:00+00:00",
    updatedAt: "2026-07-08T00:00:00+00:00",
    ...overrides,
  };
}

describe("resolveSessionTaskCounts", () => {
  it("prefers the row's server counters when present", () => {
    const row: CounterFields = {
      openAgentTaskCount: 3,
      activeAgentTaskCount: 1,
    };
    // Fallback rows would say something else entirely — they must be ignored.
    const fallback = [makeTask("t1", "done"), makeTask("t2", "failed")];
    expect(resolveSessionTaskCounts(row, fallback)).toEqual({
      open: 3,
      active: 1,
    });
  });

  it("trusts the row when either counter key is present, reading the missing sibling as 0", () => {
    const fallback = [makeTask("t1", "open")];
    expect(
      resolveSessionTaskCounts({ openAgentTaskCount: 2 }, fallback)
    ).toEqual({ open: 2, active: 0 });
    expect(
      resolveSessionTaskCounts({ activeAgentTaskCount: 1 }, fallback)
    ).toEqual({ open: 0, active: 1 });
  });

  it("uses explicit zero counters from the row without falling back", () => {
    const row: CounterFields = {
      openAgentTaskCount: 0,
      activeAgentTaskCount: 0,
    };
    const fallback = [makeTask("t1", "open"), makeTask("t2", "running")];
    expect(resolveSessionTaskCounts(row, fallback)).toEqual({
      open: 0,
      active: 0,
    });
  });

  it("classifies fallback tasks with the server predicate when both keys are absent (pre-0002 rows)", () => {
    const fallback = [
      makeTask("t1", "open"),
      // Claimed/running with a live lease ⇒ active.
      makeTask("t2", "claimed"),
      makeTask("t3", "running"),
      // Lease-expired claimed/running ⇒ reclaimable ⇒ open (attention).
      makeTask("t4", "claimed", { leaseExpired: true }),
      makeTask("t5", "running", { leaseExpired: true }),
      // Terminal states count toward neither chip.
      makeTask("t6", "done"),
      makeTask("t7", "failed"),
    ];
    expect(resolveSessionTaskCounts({}, fallback)).toEqual({
      open: 3,
      active: 2,
    });
  });

  it("returns zeros for a pre-0002 row with no fallback tasks", () => {
    expect(resolveSessionTaskCounts({}, [])).toEqual({ open: 0, active: 0 });
  });
});
