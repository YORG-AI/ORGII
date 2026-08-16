import { describe, expect, it } from "vitest";

import type { JourneySnapshot } from "@src/api/tauri/sessionJourney";

import {
  activeTask,
  hasRecoverableJourney,
  isRevisionConflict,
  visibleReviews,
} from "./sessionJourneyModel";

const snapshot = (
  overrides: Partial<JourneySnapshot> = {}
): JourneySnapshot => ({
  session_id: "s1",
  revision: 4,
  active_branch_id: "main",
  active_task_id: "task-1",
  tasks: {
    "task-1": {
      id: "task-1",
      name: "核对锚点",
      branch_id: "main",
      state: "active",
      start_sequence: 10,
      finish_sequence: null,
      outcome: null,
    },
  },
  checkpoints: {
    cp: {
      id: "cp",
      task_id: "task-1",
      message_id: "message-10",
      sequence: 10,
      name: "证据",
    },
  },
  branches: {
    main: {
      id: "main",
      parent_branch_id: "main",
      parent_anchor_message_id: null,
      anchor_sequence: 0,
      state: "active",
      handoff_capsule: null,
    },
    forkA: {
      id: "forkA",
      parent_branch_id: "main",
      parent_anchor_message_id: "message-10",
      anchor_sequence: 10,
      state: "closing",
      handoff_capsule: {
        objective: "比较",
        conclusion: "保留 A",
        open_questions: ["待确认"],
        confirmed_items: ["已验证"],
      },
    },
    forkB: {
      id: "forkB",
      parent_branch_id: "main",
      parent_anchor_message_id: "message-10",
      anchor_sequence: 10,
      state: "closed",
      handoff_capsule: {
        objective: "比较",
        conclusion: "保留 B",
        open_questions: [],
        confirmed_items: [],
      },
    },
  },
  reviews: {
    queued: {
      id: "queued",
      fork_id: "forkA",
      state: "queued",
      annotation: null,
      source_start_sequence: 10,
      source_end_sequence: 13,
      promoted_fact_ids: [],
    },
    ready: {
      id: "ready",
      fork_id: "forkB",
      state: "ready",
      annotation: "可审核",
      source_start_sequence: 10,
      source_end_sequence: 13,
      promoted_fact_ids: [],
    },
    done: {
      id: "done",
      fork_id: "forkB",
      state: "confirmed",
      annotation: "已完成",
      source_start_sequence: 10,
      source_end_sequence: 13,
      promoted_fact_ids: [],
    },
  },
  ...overrides,
});

describe("session Journey UI model", () => {
  it("renders the active task indicator and preserves start-mode data in the snapshot", () => {
    expect(activeTask(snapshot())?.name).toBe("核对锚点");
    expect(activeTask(snapshot())?.start_sequence).toBe(10);
  });

  it("keeps checkpoint exact message identity for the jump action", () => {
    expect(snapshot().checkpoints.cp.message_id).toBe("message-10");
  });

  it("keeps task finish outcome as a typed durable value", () => {
    const finished = snapshot({
      tasks: {
        "task-1": {
          ...snapshot().tasks["task-1"],
          outcome: "partially_completed",
          finish_sequence: 12,
        },
      },
    });
    expect(activeTask(finished)?.outcome).toBe("partially_completed");
  });

  it("keeps every review state visible as durable Journey history", () => {
    expect(visibleReviews(snapshot()).map((review) => review.id)).toEqual([
      "queued",
      "ready",
      "done",
    ]);
  });

  it("recognizes a recoverable task or fork once per opened session", () => {
    expect(hasRecoverableJourney(snapshot())).toBe(true);
    expect(
      hasRecoverableJourney(
        snapshot({
          active_task_id: null,
          branches: { main: snapshot().branches.main },
        })
      )
    ).toBe(false);
  });

  it("refreshes a snapshot rather than treating a revision conflict as success", () => {
    expect(
      isRevisionConflict("会话旅程操作失败：会话旅程修订冲突：期望 2，当前 3。")
    ).toBe(true);
    expect(isRevisionConflict("网络错误")).toBe(false);
  });
});
