import { describe, expect, it } from "vitest";

import type { MemberUsageDay } from "@src/features/Org2Cloud/memberRuntime/types";

import {
  clampTelemetryInterval,
  foldMemberUsageSummary,
  foldRecentDays,
  isInstalledAgentPresent,
  isRuntimeStale,
  memberUsageDayRange,
  memberUsageDaysToTrendPoints,
  parseTelemetryOption,
  readOrgRuntimeTelemetry,
  telemetrySelectValue,
  utcDayStartMs,
} from "./teamRuntimeData";

function usageDay(over: Partial<MemberUsageDay> = {}): MemberUsageDay {
  return {
    day: "2026-07-29",
    bucket: "claude",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 300,
    cacheWriteTokens: 20,
    totalTokens: 470,
    costUsd: 1.25,
    sessions: 2,
    requests: 8,
    ...over,
  };
}

describe("readOrgRuntimeTelemetry", () => {
  it("reads a well-formed runtimeTelemetry off an org record", () => {
    expect(
      readOrgRuntimeTelemetry({
        orgId: "o",
        runtimeTelemetry: { enabled: true, intervalMinutes: 60 },
      })
    ).toEqual({ enabled: true, intervalMinutes: 60 });
  });

  it("degrades to null (disabled) for absent, null, or malformed fields", () => {
    expect(readOrgRuntimeTelemetry(null)).toBeNull();
    expect(readOrgRuntimeTelemetry(undefined)).toBeNull();
    expect(readOrgRuntimeTelemetry({ orgId: "o" })).toBeNull();
    expect(readOrgRuntimeTelemetry({ runtimeTelemetry: null })).toBeNull();
    expect(
      readOrgRuntimeTelemetry({ runtimeTelemetry: { enabled: "yes" } })
    ).toBeNull();
    expect(
      readOrgRuntimeTelemetry({ runtimeTelemetry: { enabled: true } })
    ).toBeNull();
  });
});

describe("telemetry interval clamp + select value", () => {
  it("mirrors the server clamp [15, 1440]", () => {
    expect(clampTelemetryInterval(7)).toBe(15);
    expect(clampTelemetryInterval(15)).toBe(15);
    expect(clampTelemetryInterval(1440)).toBe(1440);
    expect(clampTelemetryInterval(5000)).toBe(1440);
    expect(clampTelemetryInterval(Number.NaN)).toBe(60);
  });

  it("shows off for unset or disabled telemetry", () => {
    expect(telemetrySelectValue(null)).toBe("off");
    expect(telemetrySelectValue(undefined)).toBe("off");
    expect(telemetrySelectValue({ enabled: false, intervalMinutes: 60 })).toBe(
      "off"
    );
  });

  it("displays a below-min interval as the clamped preset", () => {
    expect(telemetrySelectValue({ enabled: true, intervalMinutes: 7 })).toBe(
      "15"
    );
    expect(
      telemetrySelectValue({ enabled: true, intervalMinutes: 100000 })
    ).toBe("1440");
  });

  it("snaps a non-preset interval to the nearest option", () => {
    expect(telemetrySelectValue({ enabled: true, intervalMinutes: 60 })).toBe(
      "60"
    );
    expect(telemetrySelectValue({ enabled: true, intervalMinutes: 50 })).toBe(
      "60"
    );
    expect(telemetrySelectValue({ enabled: true, intervalMinutes: 200 })).toBe(
      "180"
    );
    expect(telemetrySelectValue({ enabled: true, intervalMinutes: 700 })).toBe(
      "360"
    );
  });

  it("round-trips select values into RPC arguments", () => {
    expect(parseTelemetryOption("off")).toEqual({
      enabled: false,
      intervalMinutes: null,
    });
    expect(parseTelemetryOption("180")).toEqual({
      enabled: true,
      intervalMinutes: 180,
    });
    expect(parseTelemetryOption("garbage")).toEqual({
      enabled: true,
      intervalMinutes: 60,
    });
  });
});

describe("isRuntimeStale", () => {
  const telemetry = { enabled: true, intervalMinutes: 60 };
  const now = Date.parse("2026-07-29T12:00:00Z");

  it("is fresh within 2× the org interval and stale beyond it", () => {
    expect(
      isRuntimeStale("2026-07-29T10:00:01Z", telemetry, now) // 1h59m59s
    ).toBe(false);
    expect(
      isRuntimeStale("2026-07-29T09:59:59Z", telemetry, now) // 2h00m01s
    ).toBe(true);
  });

  it("scales the threshold with the interval", () => {
    const quarterly = { enabled: true, intervalMinutes: 15 };
    expect(isRuntimeStale("2026-07-29T11:31:00Z", quarterly, now)).toBe(false);
    expect(isRuntimeStale("2026-07-29T11:29:00Z", quarterly, now)).toBe(true);
  });

  it("defaults to the 60-minute interval when telemetry is unknown", () => {
    expect(isRuntimeStale("2026-07-29T10:30:00Z", null, now)).toBe(false);
    expect(isRuntimeStale("2026-07-29T09:30:00Z", null, now)).toBe(true);
  });

  it("treats never-reported and unparsable stamps as stale", () => {
    expect(isRuntimeStale(null, telemetry, now)).toBe(true);
    expect(isRuntimeStale("not-a-date", telemetry, now)).toBe(true);
  });
});

describe("foldRecentDays", () => {
  it("folds by UTC day-string match, not by local calendar day", () => {
    // 2026-07-29T01:30 UTC: a viewer west of UTC (e.g. UTC-8) is still on
    // local July 28 — folding through a local Date would call today's row
    // "tomorrow" and drop it. Day strings must match regardless of TZ.
    const now = Date.parse("2026-07-29T01:30:00Z");
    const folded = foldRecentDays(
      [
        usageDay({ day: "2026-07-29", totalTokens: 100, costUsd: 1 }),
        usageDay({ day: "2026-07-28", totalTokens: 10, costUsd: 0.5 }),
      ],
      now
    );
    expect(folded.todayTokens).toBe(100);
    expect(folded.todayCostUsd).toBe(1);
    expect(folded.weekTokens).toBe(110);
    expect(folded.weekCostUsd).toBe(1.5);
  });

  it("sums all buckets of the same day and bounds the week window", () => {
    const now = Date.parse("2026-07-29T12:00:00Z");
    const folded = foldRecentDays(
      [
        usageDay({ day: "2026-07-29", bucket: "claude", totalTokens: 1 }),
        usageDay({ day: "2026-07-29", bucket: "other", totalTokens: 2 }),
        usageDay({ day: "2026-07-23", totalTokens: 4 }), // 6 days ago: in
        usageDay({ day: "2026-07-22", totalTokens: 8 }), // 7 days ago: out
      ],
      now
    );
    expect(folded.todayTokens).toBe(3);
    expect(folded.weekTokens).toBe(7);
  });

  it("is empty-safe", () => {
    const folded = foldRecentDays([], Date.now());
    expect(folded).toEqual({
      todayTokens: 0,
      todayCostUsd: 0,
      weekTokens: 0,
      weekCostUsd: 0,
    });
  });
});

describe("memberUsageDaysToTrendPoints", () => {
  it("keys each point at the UTC midnight of its day string", () => {
    const points = memberUsageDaysToTrendPoints([usageDay()]);
    expect(points).toHaveLength(1);
    expect(points[0].bucketMs).toBe(Date.parse("2026-07-29T00:00:00Z"));
    expect(points[0].bucketMs).toBe(utcDayStartMs("2026-07-29"));
  });

  it("merges buckets per day and sorts ascending", () => {
    const points = memberUsageDaysToTrendPoints([
      usageDay({
        day: "2026-07-29",
        bucket: "claude",
        inputTokens: 1,
        costUsd: 1,
      }),
      usageDay({
        day: "2026-07-28",
        bucket: "codex",
        inputTokens: 2,
        costUsd: 2,
      }),
      usageDay({
        day: "2026-07-29",
        bucket: "other",
        inputTokens: 4,
        costUsd: 4,
      }),
    ]);
    expect(points.map((point) => point.bucketMs)).toEqual([
      utcDayStartMs("2026-07-28"),
      utcDayStartMs("2026-07-29"),
    ]);
    expect(points[1].inputTokens).toBe(5);
    expect(points[1].costUsd).toBe(5);
  });

  it("filters to one bucket when asked and drops malformed days", () => {
    const points = memberUsageDaysToTrendPoints(
      [
        usageDay({ bucket: "claude", inputTokens: 1 }),
        usageDay({ bucket: "codex", inputTokens: 2 }),
        usageDay({ day: "garbage", bucket: "claude", inputTokens: 4 }),
      ],
      "claude"
    );
    expect(points).toHaveLength(1);
    expect(points[0].inputTokens).toBe(1);
  });
});

describe("foldMemberUsageSummary", () => {
  it("produces the UsageSummary shape UsageStatCards renders", () => {
    const summary = foldMemberUsageSummary([
      usageDay({
        bucket: "claude",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 300,
        cacheWriteTokens: 20,
        totalTokens: 470,
        costUsd: 1,
        sessions: 2,
        requests: 8,
      }),
      usageDay({
        day: "2026-07-28",
        bucket: "other",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: 0.5,
        sessions: 1,
        requests: 3,
      }),
    ]);
    expect(summary.sessionCount).toBe(3);
    expect(summary.requestCount).toBe(11);
    expect(summary.inputTokens).toBe(110);
    expect(summary.outputTokens).toBe(55);
    expect(summary.cacheReadTokens).toBe(300);
    expect(summary.cacheWriteTokens).toBe(20);
    expect(summary.realTotalTokens).toBe(485);
    expect(summary.totalTokens).toBe(485);
    expect(summary.costUsd).toBe(1.5);
    expect(summary.estimatedCostUsd).toBe(1.5);
    expect(summary.recordedCostUsd).toBe(0);
    // cache_read / (input + cache_write + cache_read)
    expect(summary.cacheHitRate).toBeCloseTo(300 / 430);
    expect(summary.byBucket).toEqual([
      { bucket: "claude", sessionCount: 2, realTotalTokens: 470, costUsd: 1 },
      { bucket: "other", sessionCount: 1, realTotalTokens: 15, costUsd: 0.5 },
    ]);
  });

  it("respects a bucket filter and guards a zero cache denominator", () => {
    const summary = foldMemberUsageSummary(
      [
        usageDay({
          bucket: "codex",
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        usageDay({ bucket: "claude" }),
      ],
      "codex"
    );
    expect(summary.byBucket).toHaveLength(1);
    expect(summary.byBucket[0].bucket).toBe("codex");
    expect(summary.cacheHitRate).toBe(0);
  });
});

describe("memberUsageDayRange", () => {
  it("spans an inclusive UTC window ending today", () => {
    const now = Date.parse("2026-07-29T05:00:00Z");
    expect(memberUsageDayRange(now, 30)).toEqual({
      fromDay: "2026-06-30",
      toDay: "2026-07-29",
    });
    expect(memberUsageDayRange(now, 1)).toEqual({
      fromDay: "2026-07-29",
      toDay: "2026-07-29",
    });
  });
});

describe("isInstalledAgentPresent", () => {
  it("hides only the statuses that assert absence", () => {
    expect(
      isInstalledAgentPresent({ id: "claude", status: "not_detected" })
    ).toBe(false);
    expect(
      isInstalledAgentPresent({
        id: "codex",
        status: "importable_no_history_found",
      })
    ).toBe(false);
    expect(
      isInstalledAgentPresent({
        id: "claude",
        status: "importable_history_found",
      })
    ).toBe(true);
    expect(
      isInstalledAgentPresent({ id: "warp", status: "detected_no_importer" })
    ).toBe(true);
    // Future statuses default to visible.
    expect(
      isInstalledAgentPresent({ id: "new", status: "something_new" })
    ).toBe(true);
  });
});
