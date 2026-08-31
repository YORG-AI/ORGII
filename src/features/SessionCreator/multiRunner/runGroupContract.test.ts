import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";

import { RUNNER_BLOCKER } from "./contract";
import {
  RUN_OUTCOME,
  type RunGroup,
  collectRunGroupSessionIds,
  resolveRunGroupTitle,
} from "./runGroupContract";

const RUNNER = {
  id: "runner-1",
  dispatchCategory: DISPATCH_CATEGORY.CLI_AGENT,
  cliAgentType: "claude_code" as CliAgentType,
};

describe("resolveRunGroupTitle", () => {
  it("uses a short prompt verbatim", () => {
    expect(resolveRunGroupTitle("Fix the auth crash")).toBe(
      "Fix the auth crash"
    );
  });

  it("collapses newlines and runs of whitespace into single spaces", () => {
    expect(resolveRunGroupTitle("  Fix   the\n\nauth crash \t")).toBe(
      "Fix the auth crash"
    );
  });

  it("clips a long prompt at a word boundary with an ellipsis", () => {
    const title = resolveRunGroupTitle(
      "Investigate why the login popup crashes on macOS when the OAuth window regains focus"
    );
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(49);
    expect(title).not.toContain(" …");
  });

  it("still clips a single very long word", () => {
    const title = resolveRunGroupTitle("x".repeat(200));
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(49);
  });

  it("falls back to a label for an empty prompt", () => {
    expect(resolveRunGroupTitle("   ")).toBe("Run group");
  });
});

describe("collectRunGroupSessionIds", () => {
  it("returns only launched entries, in launcher order", () => {
    const group: RunGroup = {
      id: "group-1",
      prompt: "Fix the auth crash",
      createdAt: "2026-08-22T10:00:00.000Z",
      entries: [
        {
          ordinal: 1,
          outcome: RUN_OUTCOME.LAUNCHED,
          sessionId: "session-a",
          runner: RUNNER,
        },
        {
          ordinal: 2,
          outcome: RUN_OUTCOME.SKIPPED,
          blocker: RUNNER_BLOCKER.CLI_NOT_INSTALLED,
          runner: RUNNER,
        },
        {
          ordinal: 3,
          outcome: RUN_OUTCOME.FAILED,
          error: "no key",
          runner: RUNNER,
        },
        {
          ordinal: 4,
          outcome: RUN_OUTCOME.LAUNCHED,
          sessionId: "session-d",
          runner: RUNNER,
        },
      ],
    };
    expect(collectRunGroupSessionIds(group)).toEqual([
      "session-a",
      "session-d",
    ]);
  });
});
