import { beforeEach, describe, expect, it, vi } from "vitest";

import { PlanExecutionService } from "./PlanExecutionService";

const dispatchTurnSpy = vi.hoisted(() => vi.fn());

vi.mock("./TurnDispatchService", () => ({
  dispatchTurn: dispatchTurnSpy,
}));

describe("PlanExecutionService", () => {
  beforeEach(() => {
    dispatchTurnSpy.mockReset().mockResolvedValue(undefined);
  });

  it("dispatches a plan document with the explicit execution workspace", async () => {
    await PlanExecutionService.executePlanDocument({
      sessionId: "sdeagent-plan",
      planContent: "  1. Change the parser\n2. Add tests  ",
      mode: "build",
      model: "claude-sonnet",
      accountId: "acct-1",
      workspacePath: "/workspace/repo-a",
    });

    expect(dispatchTurnSpy).toHaveBeenCalledWith({
      sessionId: "sdeagent-plan",
      content:
        "Execute the following plan document. Implement each step in order and update the todo list as you complete each step.\n\n---\n\n1. Change the parser\n2. Add tests",
      turnIntentSource: "user_submit",
      mode: "build",
      model: "claude-sonnet",
      accountId: "acct-1",
      workspacePath: "/workspace/repo-a",
    });
  });

  it("dispatches todo steps and propagates canonical failures", async () => {
    dispatchTurnSpy.mockRejectedValueOnce(new Error("transport down"));

    await expect(
      PlanExecutionService.executePlanFromTodos({
        sessionId: "sdeagent-plan",
        todos: [{ content: "First" }, { content: "Second" }],
        mode: "build",
      })
    ).rejects.toThrow("transport down");

    expect(dispatchTurnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Execute the following plan:\n\n1. First\n2. Second\n\nImplement each step in order. Update the todo list as you complete each step.",
        turnIntentSource: "user_submit",
      })
    );
  });
});
