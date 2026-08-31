import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import { RUNNER_BLOCKER } from "@src/features/SessionCreator/multiRunner/contract";
import {
  RUN_OUTCOME,
  type RunGroupEntry,
} from "@src/features/SessionCreator/multiRunner/runGroupContract";
import type { Session } from "@src/store/session";

import {
  RUN_ROW_STATE,
  canRetryRun,
  canStopRun,
  formatElapsed,
  resolveRunElapsedSeconds,
  resolveRunRowState,
} from "./runGroupRow";

const RUNNER = {
  id: "runner-1",
  dispatchCategory: DISPATCH_CATEGORY.CLI_AGENT,
  cliAgentType: "claude_code" as CliAgentType,
  runtimeConfig: { model: "opus-5" },
};

function entry(overrides: Partial<RunGroupEntry> = {}): RunGroupEntry {
  return {
    ordinal: 1,
    outcome: RUN_OUTCOME.LAUNCHED,
    sessionId: "session-1",
    runner: RUNNER,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    session_id: "session-1",
    status: "running",
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("resolveRunRowState", () => {
  it("reports a pre-flight refusal without consulting any session", () => {
    expect(
      resolveRunRowState(
        entry({
          outcome: RUN_OUTCOME.SKIPPED,
          sessionId: undefined,
          blocker: RUNNER_BLOCKER.CLI_NOT_INSTALLED,
        }),
        undefined
      )
    ).toBe(RUN_ROW_STATE.SKIPPED);
  });

  it("reports a thrown launch as failed even if a session turns up later", () => {
    expect(
      resolveRunRowState(
        entry({ outcome: RUN_OUTCOME.FAILED, error: "no key" }),
        session({ status: "completed" })
      )
    ).toBe(RUN_ROW_STATE.FAILED);
  });

  it("waits on the session record before claiming a state", () => {
    expect(resolveRunRowState(entry(), undefined)).toBe(RUN_ROW_STATE.PENDING);
  });

  it.each([
    ["running", RUN_ROW_STATE.RUNNING],
    ["pending", RUN_ROW_STATE.RUNNING],
    ["waiting_for_user", RUN_ROW_STATE.RUNNING],
    ["completed", RUN_ROW_STATE.DONE],
    ["failed", RUN_ROW_STATE.FAILED],
    ["error", RUN_ROW_STATE.FAILED],
    ["timeout", RUN_ROW_STATE.FAILED],
  ])("maps session status %s to %s", (status, expected) => {
    expect(resolveRunRowState(entry(), session({ status }))).toBe(expected);
  });

  it("distinguishes a deliberately stopped run from a failure", () => {
    // `toUnifiedStatus` folds cancelled into failed; a run the user stopped
    // because another runner already won is not a failure.
    expect(resolveRunRowState(entry(), session({ status: "cancelled" }))).toBe(
      RUN_ROW_STATE.STOPPED
    );
    expect(resolveRunRowState(entry(), session({ status: "abandoned" }))).toBe(
      RUN_ROW_STATE.STOPPED
    );
  });
});

describe("row affordances", () => {
  it("offers Stop only while a run is alive", () => {
    expect(canStopRun(RUN_ROW_STATE.RUNNING)).toBe(true);
    expect(canStopRun(RUN_ROW_STATE.DONE)).toBe(false);
    expect(canStopRun(RUN_ROW_STATE.PENDING)).toBe(false);
  });

  it("offers a retry only for runs that produced nothing usable", () => {
    expect(canRetryRun(RUN_ROW_STATE.FAILED)).toBe(true);
    expect(canRetryRun(RUN_ROW_STATE.SKIPPED)).toBe(true);
    expect(canRetryRun(RUN_ROW_STATE.DONE)).toBe(false);
    expect(canRetryRun(RUN_ROW_STATE.RUNNING)).toBe(false);
  });
});

describe("resolveRunElapsedSeconds", () => {
  const startedMs = Date.parse("2026-08-22T10:00:00.000Z");

  it("measures a live run against the current clock", () => {
    expect(resolveRunElapsedSeconds(session(), startedMs + 134_000)).toBe(134);
  });

  it("freezes a finished run at its completion time", () => {
    expect(
      resolveRunElapsedSeconds(
        session({ completed_at: "2026-08-22T10:01:48.000Z" }),
        startedMs + 999_000
      )
    ).toBe(108);
  });

  it("clamps a clock that ran backwards to zero rather than showing negatives", () => {
    expect(resolveRunElapsedSeconds(session(), startedMs - 5_000)).toBe(0);
  });

  it("returns null when there is no session or no parsable start", () => {
    expect(resolveRunElapsedSeconds(undefined, startedMs)).toBeNull();
    expect(
      resolveRunElapsedSeconds(session({ created_at: "not a date" }), startedMs)
    ).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("drops the minute segment under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("pads seconds once minutes appear so the column stays aligned", () => {
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(134)).toBe("2m 14s");
    expect(formatElapsed(3_671)).toBe("61m 11s");
  });
});
