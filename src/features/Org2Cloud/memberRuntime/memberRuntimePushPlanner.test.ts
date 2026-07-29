import { describe, expect, it } from "vitest";

import type { DailyRollupRow } from "@src/api/tauri/usageDashboard";

import {
  MEMBER_RUNTIME_BACKOFF_BASE_MS,
  MEMBER_RUNTIME_BACKOFF_CAP_MS,
  UTC_DAY_MS,
  builderProfileFingerprint,
  clampRuntimeTelemetryIntervalMinutes,
  computeOrgDueAtMs,
  drawMemberRuntimeCatchupJitterMs,
  installedAgentsFingerprint,
  mapRollupRowsToMemberUsageDays,
  memberRuntimeBackoffDelayMs,
  planUsageDaysPush,
  runtimeTelemetryRecordFingerprint,
  usageDayRowFingerprint,
  usageDayRowKey,
  utcDayFloorMs,
} from "./memberRuntimePushPlanner";
import type { MemberBuilderProfile, MemberUsageDay } from "./types";
import {
  MEMBER_RUNTIME_CATCHUP_JITTER_MAX_MS,
  MEMBER_RUNTIME_CATCHUP_JITTER_MIN_MS,
  utcDayFromMs,
} from "./types";

// Fixed reference clock: 2026-07-29T10:00:00.000Z.
const NOW = Date.UTC(2026, 6, 29, 10, 0, 0);
const MINUTE = 60_000;

function makeUsageDay(overrides: Partial<MemberUsageDay>): MemberUsageDay {
  return {
    day: "2026-07-29",
    bucket: "claude",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10,
    costUsd: 0.5,
    sessions: 1,
    requests: 2,
    ...overrides,
  };
}

describe("clampRuntimeTelemetryIntervalMinutes", () => {
  it("mirrors the server clamp [15, 1440] with a 60-minute default", () => {
    expect(clampRuntimeTelemetryIntervalMinutes(60)).toBe(60);
    expect(clampRuntimeTelemetryIntervalMinutes(5)).toBe(15);
    expect(clampRuntimeTelemetryIntervalMinutes(100_000)).toBe(1440);
    expect(clampRuntimeTelemetryIntervalMinutes(0)).toBe(60);
    expect(clampRuntimeTelemetryIntervalMinutes(-30)).toBe(60);
    expect(clampRuntimeTelemetryIntervalMinutes(Number.NaN)).toBe(60);
    expect(clampRuntimeTelemetryIntervalMinutes("45")).toBe(60);
    expect(clampRuntimeTelemetryIntervalMinutes(15.4)).toBe(15);
  });
});

describe("memberRuntimeBackoffDelayMs", () => {
  it("doubles from the 5-minute base and caps at 30 minutes", () => {
    expect(memberRuntimeBackoffDelayMs(1)).toBe(5 * MINUTE);
    expect(memberRuntimeBackoffDelayMs(2)).toBe(10 * MINUTE);
    expect(memberRuntimeBackoffDelayMs(3)).toBe(20 * MINUTE);
    expect(memberRuntimeBackoffDelayMs(4)).toBe(30 * MINUTE);
    expect(memberRuntimeBackoffDelayMs(5)).toBe(30 * MINUTE);
    expect(memberRuntimeBackoffDelayMs(100)).toBe(
      MEMBER_RUNTIME_BACKOFF_CAP_MS
    );
    expect(MEMBER_RUNTIME_BACKOFF_BASE_MS).toBe(5 * MINUTE);
  });

  it("treats a nonsensical failure count as the first failure", () => {
    expect(memberRuntimeBackoffDelayMs(0)).toBe(5 * MINUTE);
    expect(memberRuntimeBackoffDelayMs(-3)).toBe(5 * MINUTE);
  });
});

describe("drawMemberRuntimeCatchupJitterMs", () => {
  it("spans exactly [30s, 120s] over the unit interval", () => {
    expect(drawMemberRuntimeCatchupJitterMs(() => 0)).toBe(
      MEMBER_RUNTIME_CATCHUP_JITTER_MIN_MS
    );
    expect(drawMemberRuntimeCatchupJitterMs(() => 1)).toBe(
      MEMBER_RUNTIME_CATCHUP_JITTER_MAX_MS
    );
    expect(drawMemberRuntimeCatchupJitterMs(() => 0.5)).toBe(75_000);
  });

  it("clamps a wild random source into the range", () => {
    expect(drawMemberRuntimeCatchupJitterMs(() => -1)).toBe(30_000);
    expect(drawMemberRuntimeCatchupJitterMs(() => 7)).toBe(120_000);
  });
});

describe("computeOrgDueAtMs", () => {
  const base = {
    intervalMinutes: 60,
    schedulerStartAtMs: NOW,
    catchupJitterMs: 45_000,
  };

  it("keeps the exact deadline for a push that comes due while running", () => {
    expect(
      computeOrgDueAtMs({ ...base, lastPushAtMs: NOW - 10 * MINUTE })
    ).toBe(NOW - 10 * MINUTE + 60 * MINUTE);
  });

  it("applies the launch jitter when the push is overdue at start", () => {
    expect(
      computeOrgDueAtMs({ ...base, lastPushAtMs: NOW - 3 * 60 * MINUTE })
    ).toBe(NOW + 45_000);
  });

  it("applies the launch jitter when the org has never pushed", () => {
    expect(computeOrgDueAtMs({ ...base, lastPushAtMs: 0 })).toBe(NOW + 45_000);
  });

  it("clamps a too-small org interval before computing the deadline", () => {
    expect(
      computeOrgDueAtMs({
        ...base,
        intervalMinutes: 5,
        lastPushAtMs: NOW - MINUTE,
      })
    ).toBe(NOW - MINUTE + 15 * MINUTE);
  });

  it("lets the failure-backoff floor win over an earlier deadline", () => {
    // Natural deadline NOW+5min; the failure backoff floor pushes it out.
    expect(
      computeOrgDueAtMs({
        ...base,
        lastPushAtMs: NOW - 55 * MINUTE,
        backoffNotBeforeMs: NOW + 25 * MINUTE,
      })
    ).toBe(NOW + 25 * MINUTE);
    // And never pulls an already-later deadline in.
    expect(
      computeOrgDueAtMs({
        ...base,
        lastPushAtMs: NOW - 10 * MINUTE,
        backoffNotBeforeMs: NOW + 25 * MINUTE,
      })
    ).toBe(NOW + 50 * MINUTE);
  });
});

describe("mapRollupRowsToMemberUsageDays", () => {
  function makeRow(overrides: Partial<DailyRollupRow>): DailyRollupRow {
    return {
      dayStartMs: utcDayFloorMs(NOW),
      bucket: "claude",
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 400,
      totalTokens: 1000,
      costUsd: 1.25,
      sessions: 3,
      requests: 7,
      ...overrides,
    };
  }

  it("maps day floors to UTC day strings via utcDayFromMs", () => {
    const days = mapRollupRowsToMemberUsageDays([
      makeRow({}),
      makeRow({ dayStartMs: utcDayFloorMs(NOW) - UTC_DAY_MS, bucket: "other" }),
    ]);
    expect(days).toEqual([
      {
        day: "2026-07-29",
        bucket: "claude",
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 400,
        totalTokens: 1000,
        costUsd: 1.25,
        sessions: 3,
        requests: 7,
      },
      expect.objectContaining({ day: "2026-07-28", bucket: "other" }),
    ]);
  });

  it("keeps utcDayFloorMs consistent with utcDayFromMs at day boundaries", () => {
    const lateInDay = Date.UTC(2026, 6, 29, 23, 59, 59, 999);
    const floored = utcDayFloorMs(lateInDay);
    expect(utcDayFromMs(floored)).toBe(utcDayFromMs(lateInDay));
    expect(utcDayFromMs(floored)).toBe("2026-07-29");
    expect(utcDayFloorMs(floored + UTC_DAY_MS)).toBe(floored + UTC_DAY_MS);
    expect(utcDayFromMs(floored + UTC_DAY_MS)).toBe("2026-07-30");
  });

  it("clamps malformed numerics to zero and drops unknown buckets", () => {
    const days = mapRollupRowsToMemberUsageDays([
      makeRow({ inputTokens: -5, costUsd: Number.NaN }),
      makeRow({ bucket: "mystery" }),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0].inputTokens).toBe(0);
    expect(days[0].costUsd).toBe(0);
  });
});

describe("planUsageDaysPush", () => {
  it("skips rows whose fingerprint is unchanged since the last push", () => {
    const unchanged = makeUsageDay({ day: "2026-07-28" });
    const changed = makeUsageDay({ day: "2026-07-29", inputTokens: 999 });
    const previous = {
      [usageDayRowKey(unchanged)]: usageDayRowFingerprint(unchanged),
      [usageDayRowKey(changed)]: "stale",
    };
    const plan = planUsageDaysPush([unchanged, changed], previous);
    expect(plan.days).toEqual([changed]);
    // Unchanged row keeps its fingerprint entry; sent row gets the new one.
    expect(plan.fingerprintsAfterPush).toEqual({
      [usageDayRowKey(unchanged)]: usageDayRowFingerprint(unchanged),
      [usageDayRowKey(changed)]: usageDayRowFingerprint(changed),
    });
  });

  it("sends everything on first contact (no previous fingerprints)", () => {
    const rows = [
      makeUsageDay({ day: "2026-07-28" }),
      makeUsageDay({ day: "2026-07-29" }),
    ];
    const plan = planUsageDaysPush(rows, {});
    expect(plan.days).toHaveLength(2);
    // Newest day first.
    expect(plan.days[0].day).toBe("2026-07-29");
  });

  it("caps the batch preferring the newest days", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      makeUsageDay({
        day: utcDayFromMs(utcDayFloorMs(NOW) - index * UTC_DAY_MS),
      })
    );
    const plan = planUsageDaysPush(rows, {}, 3);
    expect(plan.days.map((row) => row.day)).toEqual([
      "2026-07-29",
      "2026-07-28",
      "2026-07-27",
    ]);
    // Rows squeezed out by the cap have NO fingerprint recorded, so they
    // still count as changed on the next tick.
    expect(Object.keys(plan.fingerprintsAfterPush)).toHaveLength(3);
  });

  it("keeps a stale fingerprint for a changed row squeezed out by the cap", () => {
    const newest = makeUsageDay({ day: "2026-07-29", inputTokens: 11 });
    const older = makeUsageDay({ day: "2026-07-28", inputTokens: 22 });
    const previous = {
      [usageDayRowKey(newest)]: "stale-new",
      [usageDayRowKey(older)]: "stale-old",
    };
    const plan = planUsageDaysPush([older, newest], previous, 1);
    expect(plan.days).toEqual([newest]);
    expect(plan.fingerprintsAfterPush[usageDayRowKey(newest)]).toBe(
      usageDayRowFingerprint(newest)
    );
    expect(plan.fingerprintsAfterPush[usageDayRowKey(older)]).toBe("stale-old");
  });

  it("prunes fingerprints for days that fell out of the rollup window", () => {
    const current = makeUsageDay({ day: "2026-07-29" });
    const previous = {
      [usageDayRowKey(current)]: usageDayRowFingerprint(current),
      "2026-01-01|claude": "ancient",
    };
    const plan = planUsageDaysPush([current], previous);
    expect(plan.days).toEqual([]);
    expect(plan.fingerprintsAfterPush).toEqual({
      [usageDayRowKey(current)]: usageDayRowFingerprint(current),
    });
  });

  it("orders same-day rows by the canonical bucket order", () => {
    const rows = [
      makeUsageDay({ bucket: "other" }),
      makeUsageDay({ bucket: "claude" }),
      makeUsageDay({ bucket: "org2" }),
    ];
    const plan = planUsageDaysPush(rows, {});
    expect(plan.days.map((row) => row.bucket)).toEqual([
      "claude",
      "org2",
      "other",
    ]);
  });
});

describe("fingerprints", () => {
  function makeProfile(
    code: string,
    letters: Array<[string, string, number]>
  ): MemberBuilderProfile {
    return {
      code,
      archetype: null,
      blurbs: ["presentation prose"],
      confidence: 0.8,
      sessions: 42,
      hasEnoughSessions: true,
      axes: letters.map(([key, letter, score]) => ({
        key,
        letter,
        score,
        clarity: "clear",
      })),
      secondary: [],
      subagentSessionShare: 0,
      startedAtMs: 0,
      endedAtMs: 0,
    } as unknown as MemberBuilderProfile;
  }

  it("changes the profile fingerprint when a letter or score flips", () => {
    const base = makeProfile("MDFS", [["ME", "M", 40]]);
    expect(builderProfileFingerprint(base)).toBe(
      builderProfileFingerprint(makeProfile("MDFS", [["ME", "M", 40]]))
    );
    expect(builderProfileFingerprint(base)).not.toBe(
      builderProfileFingerprint(makeProfile("MDFS", [["ME", "E", 40]]))
    );
    expect(builderProfileFingerprint(base)).not.toBe(
      builderProfileFingerprint(makeProfile("EDFS", [["ME", "M", 40]]))
    );
  });

  it("ignores presentation-only fields in the profile fingerprint", () => {
    const left = makeProfile("MDFS", [["ME", "M", 40]]);
    const right = {
      ...makeProfile("MDFS", [["ME", "M", 40]]),
      blurbs: ["different prose"],
      confidence: 0.9,
    } as MemberBuilderProfile;
    expect(builderProfileFingerprint(left)).toBe(
      builderProfileFingerprint(right)
    );
  });

  it("makes the agents fingerprint order-insensitive", () => {
    const left = installedAgentsFingerprint([
      { id: "claude", status: "installed" },
      { id: "codex", status: "not_installed" },
    ]);
    const right = installedAgentsFingerprint([
      { id: "codex", status: "not_installed" },
      { id: "claude", status: "installed" },
    ]);
    expect(left).toBe(right);
    expect(left).not.toBe(
      installedAgentsFingerprint([
        { id: "claude", status: "removed" },
        { id: "codex", status: "not_installed" },
      ])
    );
  });

  it("keys the disabled verdict to the org record content", () => {
    expect(
      runtimeTelemetryRecordFingerprint({ enabled: true, intervalMinutes: 60 })
    ).toBe(
      runtimeTelemetryRecordFingerprint({ enabled: true, intervalMinutes: 60 })
    );
    expect(
      runtimeTelemetryRecordFingerprint({ enabled: true, intervalMinutes: 60 })
    ).not.toBe(
      runtimeTelemetryRecordFingerprint({ enabled: true, intervalMinutes: 30 })
    );
    expect(runtimeTelemetryRecordFingerprint(null)).toBe(
      runtimeTelemetryRecordFingerprint(undefined)
    );
  });
});
