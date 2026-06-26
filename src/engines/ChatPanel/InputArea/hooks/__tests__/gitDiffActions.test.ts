import { describe, expect, it, vi } from "vitest";

import {
  GIT_DIFF_COMMIT_PROMPT,
  GIT_DIFF_COMMIT_PUSH_PROMPT,
  GIT_DIFF_PUSH_PROMPT,
  type RunAgentGitActionDeps,
  computeGitActionsDisabled,
  runAgentGitAction,
} from "../gitDiffActions";

function createDeps(
  overrides: Partial<RunAgentGitActionDeps> = {}
): RunAgentGitActionDeps {
  return {
    sessionId: "session-1",
    isSessionActive: false,
    guard: { current: false },
    prompt: GIT_DIFF_COMMIT_PROMPT,
    submitPrompt: vi.fn(async () => {}),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("computeGitActionsDisabled", () => {
  it("is enabled for an idle session", () => {
    expect(
      computeGitActionsDisabled({ isSessionActive: false, sessionId: "s" })
    ).toBe(false);
  });

  it("is disabled while the session is active", () => {
    expect(
      computeGitActionsDisabled({ isSessionActive: true, sessionId: "s" })
    ).toBe(true);
  });

  it("is disabled with no session id", () => {
    expect(
      computeGitActionsDisabled({ isSessionActive: false, sessionId: null })
    ).toBe(true);
    expect(
      computeGitActionsDisabled({
        isSessionActive: false,
        sessionId: undefined,
      })
    ).toBe(true);
    expect(
      computeGitActionsDisabled({ isSessionActive: false, sessionId: "" })
    ).toBe(true);
  });
});

describe("runAgentGitAction", () => {
  it("dispatches the commit prompt through the agent in order", async () => {
    const deps = createDeps({ prompt: GIT_DIFF_COMMIT_PROMPT });

    const dispatched = await runAgentGitAction(deps);

    expect(dispatched).toBe(true);
    expect(deps.submitPrompt).toHaveBeenCalledWith(
      "session-1",
      GIT_DIFF_COMMIT_PROMPT
    );
    expect(deps.guard.current).toBe(false);
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("dispatches the commit & push prompt", async () => {
    const deps = createDeps({ prompt: GIT_DIFF_COMMIT_PUSH_PROMPT });

    await runAgentGitAction(deps);

    expect(deps.submitPrompt).toHaveBeenCalledWith(
      "session-1",
      GIT_DIFF_COMMIT_PUSH_PROMPT
    );
  });

  it("dispatches the push prompt", async () => {
    const deps = createDeps({ prompt: GIT_DIFF_PUSH_PROMPT });

    await runAgentGitAction(deps);

    expect(deps.submitPrompt).toHaveBeenCalledWith(
      "session-1",
      GIT_DIFF_PUSH_PROMPT
    );
  });

  it("skips when no session id", async () => {
    const deps = createDeps({ sessionId: null });

    const dispatched = await runAgentGitAction(deps);

    expect(dispatched).toBe(false);
    expect(deps.submitPrompt).not.toHaveBeenCalled();
  });

  it("skips when the session is busy", async () => {
    const deps = createDeps({ isSessionActive: true });

    const dispatched = await runAgentGitAction(deps);

    expect(dispatched).toBe(false);
    expect(deps.submitPrompt).not.toHaveBeenCalled();
  });

  it("skips re-entrant calls while one is pending", async () => {
    const guard = { current: false };
    let releaseFirst: () => void = () => {};
    const submitPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        })
    );
    const deps = createDeps({ guard, submitPrompt });

    const first = runAgentGitAction(deps);
    // Guard is held while the first action awaits.
    expect(guard.current).toBe(true);

    const second = await runAgentGitAction(deps);
    expect(second).toBe(false);
    expect(submitPrompt).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    expect(guard.current).toBe(false);
  });

  it("reports errors and releases the guard", async () => {
    const error = new Error("dispatch failed");
    const deps = createDeps({
      submitPrompt: vi.fn(async () => {
        throw error;
      }),
    });

    const dispatched = await runAgentGitAction(deps);

    expect(dispatched).toBe(false);
    expect(deps.onError).toHaveBeenCalledWith(error);
    expect(deps.guard.current).toBe(false);
  });
});
