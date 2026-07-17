import { describe, expect, it } from "vitest";

import {
  type CloudCommentTasksByOrg,
  mergeCommentTasks,
  taskForComment,
  tasksForSession,
} from "./org2CloudCommentTasksAtom";
import type { CloudCommentTask } from "./org2CloudCommentTasksClient";

let sequence = 0;

/** comment_task_wire row as parsed by CloudCommentTaskWireSchema. */
function task(
  overrides: Partial<CloudCommentTask> & { id: string }
): CloudCommentTask {
  sequence += 1;
  const stamp = `2026-07-07T10:${String(sequence).padStart(2, "0")}:00.000Z`;
  return {
    sessionId: "sess-1",
    commentId: `comment-${overrides.id}`,
    state: "open",
    leaseExpired: false,
    attempt: 0,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

describe("mergeCommentTasks (updated_at LWW by id)", () => {
  it("inserts unknown rows keyed by task id", () => {
    const merged = mergeCommentTasks({}, [
      task({ id: "t1" }),
      task({ id: "t2" }),
    ]);
    expect(Object.keys(merged).sort()).toEqual(["t1", "t2"]);
    expect(merged["t1"].commentId).toBe("comment-t1");
  });

  it("newer incoming replaces; strictly newer existing rows survive", () => {
    const existing = mergeCommentTasks({}, [
      task({ id: "t1", state: "open", updatedAt: "2026-07-07T12:00:00.000Z" }),
      task({
        id: "t2",
        state: "running",
        updatedAt: "2026-07-07T12:00:00.000Z",
      }),
    ]);
    const merged = mergeCommentTasks(existing, [
      // Newer: the delta observed a claim after our last pass.
      task({
        id: "t1",
        state: "claimed",
        updatedAt: "2026-07-07T12:00:05.000Z",
      }),
      // Older: the 2s cursor-overlap re-delivery must never clobber a
      // fresher local write-through (e.g. a stored claim response).
      task({ id: "t2", state: "open", updatedAt: "2026-07-07T11:59:59.000Z" }),
    ]);
    expect(merged["t1"].state).toBe("claimed");
    expect(merged["t2"].state).toBe("running");
    // Untouched rows keep their object identity (no gratuitous clones).
    expect(merged["t2"]).toBe(existing["t2"]);
  });

  it("ties go to the incoming row (server truth on overlap re-delivery)", () => {
    const existing = mergeCommentTasks({}, [
      task({ id: "t1", state: "open", updatedAt: "2026-07-07T12:00:00.000Z" }),
    ]);
    const rerun = task({
      id: "t1",
      state: "done",
      // Same instant, Postgres offset rendering instead of Z.
      updatedAt: "2026-07-07T12:00:00+00:00",
    });
    expect(mergeCommentTasks(existing, [rerun])["t1"].state).toBe("done");
  });

  it("compares updatedAt numerically — trimmed fractional seconds must not mis-order", () => {
    // Lexicographically "…00Z" > "…00.500Z" ("Z" > "."), which would wrongly
    // keep the existing row; numerically the incoming row is 500ms newer.
    const existing = mergeCommentTasks({}, [
      task({ id: "t1", state: "open", updatedAt: "2026-07-07T12:00:00Z" }),
    ]);
    const merged = mergeCommentTasks(existing, [
      task({
        id: "t1",
        state: "claimed",
        updatedAt: "2026-07-07T12:00:00.500Z",
      }),
    ]);
    expect(merged["t1"].state).toBe("claimed");
    // And the reverse re-delivery is discarded.
    const back = mergeCommentTasks(merged, [
      task({ id: "t1", state: "open", updatedAt: "2026-07-07T12:00:00Z" }),
    ]);
    expect(back["t1"].state).toBe("claimed");
  });

  it("returns the SAME reference when nothing changed (no atom churn)", () => {
    const existing = mergeCommentTasks({}, [
      task({ id: "t1", updatedAt: "2026-07-07T12:00:00.000Z" }),
    ]);
    // Empty delta — the engine's common 60s case.
    expect(mergeCommentTasks(existing, [])).toBe(existing);
    // Delta made entirely of stale re-deliveries.
    const stale = task({ id: "t1", updatedAt: "2026-07-07T11:00:00.000Z" });
    expect(mergeCommentTasks(existing, [stale])).toBe(existing);
  });

  it("never mutates its inputs", () => {
    const existing = mergeCommentTasks({}, [
      task({ id: "t1", state: "open", updatedAt: "2026-07-07T12:00:00.000Z" }),
    ]);
    const snapshot = { ...existing };
    const merged = mergeCommentTasks(existing, [
      task({ id: "t1", state: "done", updatedAt: "2026-07-07T12:00:05.000Z" }),
    ]);
    expect(merged).not.toBe(existing);
    expect(existing).toEqual(snapshot);
    expect(existing["t1"].state).toBe("open");
  });

  it("folds duplicate ids inside one delta under the same LWW", () => {
    const merged = mergeCommentTasks({}, [
      task({ id: "t1", state: "done", updatedAt: "2026-07-07T12:00:09.000Z" }),
      task({
        id: "t1",
        state: "claimed",
        updatedAt: "2026-07-07T12:00:01.000Z",
      }),
    ]);
    expect(merged["t1"].state).toBe("done");
  });
});

describe("tasksForSession", () => {
  it("filters by (orgId, sessionId) and sorts (createdAt, id)", () => {
    const map: CloudCommentTasksByOrg = {
      "org-1": mergeCommentTasks({}, [
        task({ id: "b", createdAt: "2026-07-07T02:00:00.000Z" }),
        task({ id: "a", createdAt: "2026-07-07T01:00:00.000Z" }),
        // Same createdAt as "b": id is the deterministic tiebreak.
        task({ id: "c", createdAt: "2026-07-07T02:00:00.000Z" }),
        task({ id: "elsewhere", sessionId: "sess-2" }),
      ]),
    };
    expect(
      tasksForSession(map, "org-1", "sess-1").map((entry) => entry.id)
    ).toEqual(["a", "b", "c"]);
  });

  it("scopes by org — local session ids may collide across orgs", () => {
    const map: CloudCommentTasksByOrg = {
      "org-1": mergeCommentTasks({}, [task({ id: "t1", sessionId: "sess-x" })]),
      "org-2": mergeCommentTasks({}, [task({ id: "t2", sessionId: "sess-x" })]),
    };
    expect(
      tasksForSession(map, "org-1", "sess-x").map((entry) => entry.id)
    ).toEqual(["t1"]);
  });

  it("unknown org or session yields []", () => {
    expect(tasksForSession({}, "org-1", "sess-1")).toEqual([]);
    const map: CloudCommentTasksByOrg = {
      "org-1": mergeCommentTasks({}, [task({ id: "t1" })]),
    };
    expect(tasksForSession(map, "org-1", "sess-nope")).toEqual([]);
    expect(tasksForSession(map, "org-nope", "sess-1")).toEqual([]);
  });
});

describe("taskForComment", () => {
  it("finds the thread head's unique task across orgs", () => {
    const map: CloudCommentTasksByOrg = {
      "org-1": mergeCommentTasks({}, [task({ id: "t1" })]),
      "org-2": mergeCommentTasks({}, [task({ id: "t2" })]),
    };
    expect(taskForComment(map, "comment-t2")?.id).toBe("t2");
  });

  it("returns undefined when no task references the comment", () => {
    const map: CloudCommentTasksByOrg = {
      "org-1": mergeCommentTasks({}, [task({ id: "t1" })]),
    };
    expect(taskForComment(map, "comment-unknown")).toBeUndefined();
    expect(taskForComment({}, "comment-t1")).toBeUndefined();
  });
});
