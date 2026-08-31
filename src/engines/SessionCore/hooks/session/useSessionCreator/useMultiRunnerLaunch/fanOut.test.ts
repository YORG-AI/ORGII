import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import {
  RUNNER_BLOCKER,
  type Runner,
} from "@src/features/SessionCreator/multiRunner/contract";
import { RUN_OUTCOME } from "@src/features/SessionCreator/multiRunner/runGroupContract";
import type { WorktreeLaunchSelection } from "@src/store/session/worktreeLaunchSourceAtom";

import { fanOutRunners, sanitizeWorktreeSelectionForFanOut } from "./fanOut";

function runner(id: string): Runner {
  return {
    id,
    dispatchCategory: DISPATCH_CATEGORY.CLI_AGENT,
    cliAgentType: "claude_code" as CliAgentType,
    runtimeConfig: { model: "opus-5" },
  };
}

const NO_BLOCKERS = () => null;
const NO_STAGGER = () => Promise.resolve();

describe("fanOutRunners", () => {
  it("launches every eligible runner and reports launcher-order ordinals", async () => {
    const launched: string[] = [];
    const entries = await fanOutRunners({
      runners: [runner("a"), runner("b"), runner("c")],
      resolveBlocker: NO_BLOCKERS,
      stagger: NO_STAGGER,
      launchRunner: async (current) => {
        launched.push(current.id);
        return `session-${current.id}`;
      },
    });

    expect(launched).toEqual(["a", "b", "c"]);
    expect(entries.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.sessionId)).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
    expect(
      entries.every((entry) => entry.outcome === RUN_OUTCOME.LAUNCHED)
    ).toBe(true);
  });

  it("keeps launching siblings after one runner throws", async () => {
    const entries = await fanOutRunners({
      runners: [runner("a"), runner("b"), runner("c")],
      resolveBlocker: NO_BLOCKERS,
      stagger: NO_STAGGER,
      launchRunner: async (current) => {
        if (current.id === "b") throw new Error("provider refused");
        return `session-${current.id}`;
      },
    });

    expect(entries.map((entry) => entry.outcome)).toEqual([
      RUN_OUTCOME.LAUNCHED,
      RUN_OUTCOME.FAILED,
      RUN_OUTCOME.LAUNCHED,
    ]);
    expect(entries[1]?.error).toBe("provider refused");
    expect(entries[1]?.sessionId).toBeUndefined();
  });

  it("skips blocked runners without attempting a launch", async () => {
    const attempted: string[] = [];
    const entries = await fanOutRunners({
      runners: [runner("a"), runner("b")],
      resolveBlocker: (current) =>
        current.id === "a" ? RUNNER_BLOCKER.CLI_NOT_INSTALLED : null,
      stagger: NO_STAGGER,
      launchRunner: async (current) => {
        attempted.push(current.id);
        return `session-${current.id}`;
      },
    });

    expect(attempted).toEqual(["b"]);
    expect(entries[0]).toMatchObject({
      ordinal: 1,
      outcome: RUN_OUTCOME.SKIPPED,
      blocker: RUNNER_BLOCKER.CLI_NOT_INSTALLED,
    });
    expect(entries[1]).toMatchObject({ ordinal: 2, sessionId: "session-b" });
  });

  it("staggers between launches but not before the first", async () => {
    let staggers = 0;
    await fanOutRunners({
      runners: [runner("a"), runner("b"), runner("c")],
      resolveBlocker: NO_BLOCKERS,
      stagger: async () => {
        staggers += 1;
      },
      launchRunner: async (current) => `session-${current.id}`,
    });
    expect(staggers).toBe(2);
  });

  it("does not count a skipped runner as an attempt for staggering", async () => {
    let staggers = 0;
    await fanOutRunners({
      runners: [runner("a"), runner("b")],
      resolveBlocker: (current) =>
        current.id === "a" ? RUNNER_BLOCKER.NO_MODEL : null,
      stagger: async () => {
        staggers += 1;
      },
      launchRunner: async (current) => `session-${current.id}`,
    });
    expect(staggers).toBe(0);
  });

  it("surfaces every failure when nothing launches", async () => {
    const entries = await fanOutRunners({
      runners: [runner("a"), runner("b")],
      resolveBlocker: NO_BLOCKERS,
      stagger: NO_STAGGER,
      launchRunner: async () => {
        throw new Error("no key");
      },
    });
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.outcome === RUN_OUTCOME.FAILED)).toBe(
      true
    );
  });

  it("snapshots the runner config onto each entry", async () => {
    const first = runner("a");
    const entries = await fanOutRunners({
      runners: [first],
      resolveBlocker: NO_BLOCKERS,
      stagger: NO_STAGGER,
      launchRunner: async () => "session-a",
    });
    expect(entries[0]?.runner).toEqual(first);
  });
});

describe("sanitizeWorktreeSelectionForFanOut", () => {
  it("passes a fresh-isolate selection through untouched", () => {
    const selection: WorktreeLaunchSelection = {
      repoKey: "id:repo-1",
      source: { kind: "branch", label: "develop", baseBranch: "develop" },
    };
    expect(sanitizeWorktreeSelectionForFanOut(selection)).toBe(selection);
  });

  it("drops a reused checkout so runners cannot share one working tree", () => {
    const sanitized = sanitizeWorktreeSelectionForFanOut({
      repoKey: "id:repo-1",
      source: {
        kind: "worktree",
        label: "agent/existing",
        baseBranch: "develop",
        existingWorktreePath: "/tmp/wt/existing",
      },
    });
    expect(sanitized?.source.existingWorktreePath).toBeUndefined();
    // The base ref survives: isolated worktrees still branch off what the
    // user picked.
    expect(sanitized?.source.baseBranch).toBe("develop");
  });

  it("passes null through", () => {
    expect(sanitizeWorktreeSelectionForFanOut(null)).toBeNull();
  });
});
