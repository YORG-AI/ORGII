import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateCommitMessage } from "@src/api/tauri/git/commitMessage";

import {
  GIT_DIFF_COMMIT_PROMPT,
  GIT_DIFF_COMMIT_PUSH_PROMPT,
  GIT_DIFF_PUSH_PROMPT,
  type RunAgentGitActionDeps,
  buildGitDiffCommitPrompt,
  buildGitDiffCommitPushPrompt,
  buildGitDiffCreatePrPrompt,
  computeGitActionsDisabled,
  runAgentGitAction,
} from "../gitDiffActions";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("feat(git): customize prompts");
});

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

describe("git action prompt customization", () => {
  it("preserves builtin prompts for empty instructions", () => {
    expect(buildGitDiffCommitPrompt()).toBe(GIT_DIFF_COMMIT_PROMPT);
    expect(buildGitDiffCommitPushPrompt("  \n ")).toBe(
      GIT_DIFF_COMMIT_PUSH_PROMPT
    );
  });

  it("appends commit instructions to commit and commit & push only", () => {
    const instructions = "  Write in English.  ";
    const commitPrompt = buildGitDiffCommitPrompt(instructions);
    const commitPushPrompt = buildGitDiffCommitPushPrompt(instructions);

    expect(commitPrompt).toContain(GIT_DIFF_COMMIT_PROMPT);
    expect(commitPushPrompt).toContain(GIT_DIFF_COMMIT_PUSH_PROMPT);
    expect(commitPrompt).toContain(
      "User-configured additional instructions:\nWrite in English."
    );
    expect(commitPushPrompt).toContain(
      "User-configured additional instructions:\nWrite in English."
    );
    expect(GIT_DIFF_PUSH_PROMPT).not.toContain("Write in English.");
  });

  it("applies pull request instructions only to the PR prompt", () => {
    const prompt = buildGitDiffCreatePrPrompt("Include a testing section.");

    expect(prompt).toContain("Action: Create a pull request");
    expect(prompt).toContain("Include a testing section.");
    expect(buildGitDiffCommitPrompt()).not.toContain(
      "Include a testing section."
    );
  });
});

describe("commit message generation contract", () => {
  it("passes normalized instructions to the Tauri command", async () => {
    await generateCommitMessage(
      "/repo",
      "  Write in English.\nInclude a body.  "
    );

    expect(invokeMock).toHaveBeenCalledWith("generate_commit_message", {
      repoPath: "/repo",
      commitInstructions: "Write in English.\nInclude a body.",
    });
  });

  it.each([undefined, "", " \n "])(
    "uses null for empty instructions (%s)",
    async (instructions) => {
      await generateCommitMessage("/repo", instructions);

      expect(invokeMock).toHaveBeenCalledWith("generate_commit_message", {
        repoPath: "/repo",
        commitInstructions: null,
      });
    }
  );
});

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
