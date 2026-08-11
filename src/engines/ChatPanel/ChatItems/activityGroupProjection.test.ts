import { describe, expect, it } from "vitest";

import {
  TOOL_USAGE_ARGS_KEY,
  type ToolUsageMetadata,
} from "@src/engines/SessionCore/core/types";
import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import {
  aggregateActivityGroupToolUsage,
  buildActivityGroupItems,
  suppressIntermediateRunningState,
} from "./activityGroupProjection";

function usage(value: number, attributionMethod: string): ToolUsageMetadata {
  return {
    decisionCompletionTokens: value,
    resultContextTokens: value,
    followupCompletionTokens: value,
    inputBytes: value,
    outputBytes: value,
    relatedCacheReadTokens: value,
    relatedCacheWriteTokens: value,
    attributionMethod,
  };
}

describe("activity group projection", () => {
  it("marks only the final event as the live group tail", () => {
    const first = makeSessionEvent();
    const second = makeSessionEvent();

    expect(buildActivityGroupItems([first, second])).toEqual([
      { event: first, isLastItem: false },
      { event: second, isLastItem: true },
    ]);
  });

  it("suppresses a stale running state only before the live tail", () => {
    const running = makeSessionEvent({
      displayStatus: "running",
      activityStatus: "agent",
      isDelta: true,
    });

    expect(suppressIntermediateRunningState(running, true)).toBe(running);
    expect(suppressIntermediateRunningState(running, false)).toMatchObject({
      displayStatus: "completed",
      activityStatus: "processed",
      isDelta: false,
    });
  });

  it("aggregates direct and serialized tool usage metadata", () => {
    const first = makeSessionEvent();
    first.toolUsage = usage(2, "direct");
    const second = makeSessionEvent({
      args: { [TOOL_USAGE_ARGS_KEY]: usage(3, "fallback") },
    });

    expect(aggregateActivityGroupToolUsage([first, second])).toEqual(
      usage(5, "fallback")
    );
  });

  it("returns no badge data when the group has no usage metadata", () => {
    expect(
      aggregateActivityGroupToolUsage([makeSessionEvent()])
    ).toBeUndefined();
  });
});
