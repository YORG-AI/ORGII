import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_SWITCH_PERFORMANCE_PREFIX,
  finishSessionSwitchTrace,
  markSessionSwitchTrace,
  resetSessionSwitchPerformanceForTests,
  startSessionSwitchTrace,
} from "./sessionSwitchPerformance";

interface UserTimingCall {
  name: string;
  options?: unknown;
}

describe("session switch performance traces", () => {
  const marks: UserTimingCall[] = [];
  const measures: UserTimingCall[] = [];
  const clearMarks = vi.fn();
  const clearMeasures = vi.fn();

  beforeEach(() => {
    marks.length = 0;
    measures.length = 0;
    clearMarks.mockReset();
    clearMeasures.mockReset();
    vi.stubGlobal("performance", {
      clearMarks,
      clearMeasures,
      mark: (name: string, options?: unknown) => {
        marks.push({ name, options });
      },
      measure: (name: string, options?: unknown) => {
        measures.push({ name, options });
      },
    });
    resetSessionSwitchPerformanceForTests();
  });

  afterEach(() => {
    resetSessionSwitchPerformanceForTests();
    vi.unstubAllGlobals();
  });

  it("records stage segments and a final painted measure", () => {
    startSessionSwitchTrace("session-a", "session-jump");
    markSessionSwitchTrace("session-a", "state-cleared");
    markSessionSwitchTrace("session-a", "rust-switch-complete", {
      cacheHit: true,
    });
    finishSessionSwitchTrace("session-a", "painted");

    expect(marks.map(({ name }) => name)).toEqual([
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:mark:start`,
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:mark:state-cleared`,
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:mark:rust-switch-complete`,
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:mark:painted`,
    ]);
    expect(measures.map(({ name }) => name)).toContain(
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:total-to:painted`
    );
    expect(marks[2].options).toMatchObject({
      detail: {
        cacheHit: true,
        sessionId: "session-a",
        stage: "rust-switch-complete",
      },
    });
  });

  it("joins the click trace when the pipeline effect sees the same session", () => {
    const clickTrace = startSessionSwitchTrace("session-a", "workstation-tab");
    const pipelineTrace = startSessionSwitchTrace(
      "session-a",
      "pipeline-effect",
      { joinExisting: true }
    );

    expect(pipelineTrace).toBe(clickTrace);
    expect(marks).toHaveLength(1);
  });

  it("drops late stages from a superseded session", () => {
    startSessionSwitchTrace("session-a", "session-jump");
    startSessionSwitchTrace("session-b", "session-jump");

    markSessionSwitchTrace("session-a", "rust-switch-complete");
    markSessionSwitchTrace("session-b", "rust-switch-complete");

    expect(marks.map(({ name }) => name)).toEqual([
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:mark:start`,
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:mark:superseded`,
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000002:mark:start`,
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000002:mark:rust-switch-complete`,
    ]);
  });

  it("bounds retained performance entries to the latest twenty traces", () => {
    for (let index = 0; index < 21; index += 1) {
      const sessionId = `session-${index}`;
      startSessionSwitchTrace(sessionId, "session-jump");
      finishSessionSwitchTrace(sessionId, "painted");
    }

    expect(clearMarks).toHaveBeenCalledWith(
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:mark:start`
    );
    expect(clearMeasures).toHaveBeenCalledWith(
      `${SESSION_SWITCH_PERFORMANCE_PREFIX}:000001:total-to:painted`
    );
  });
});
