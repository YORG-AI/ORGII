import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionJourneyApi } from ".";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("session Journey typed desktop API", () => {
  beforeEach(() => invoke.mockReset());

  it("uses centralized command names and camelCase Tauri request fields", async () => {
    await sessionJourneyApi.startTask({
      sessionId: "s",
      expectedRevision: 3,
      taskId: "t",
      name: "任务",
      position: "最近用户消息",
    });
    expect(invoke).toHaveBeenCalledWith("journey_task_start", {
      request: {
        sessionId: "s",
        expectedRevision: 3,
        taskId: "t",
        name: "任务",
        position: "最近用户消息",
      },
    });
  });

  it("keeps review confirmation, explicit discard, and exact return anchor behind typed API methods", async () => {
    await sessionJourneyApi.confirm({
      sessionId: "s",
      expectedRevision: 3,
      reviewId: "r",
      factId: "f",
      text: "确认",
      evidenceStartMessageId: "m1",
      evidenceEndMessageId: "m2",
    });
    await sessionJourneyApi.discard({
      sessionId: "s",
      expectedRevision: 4,
      reviewId: "r",
    });
    await sessionJourneyApi.returnToParent({
      sessionId: "s",
      expectedRevision: 5,
      reviewId: "r",
    });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "journey_confirm",
      "journey_discard",
      "journey_return_parent",
    ]);
  });
});
