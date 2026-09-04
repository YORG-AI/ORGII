import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetCacheRegistryForTests,
  listRegisteredCaches,
  registerCache,
  trimRegisteredCaches,
} from "./cacheRegistry";

function fakeCache(
  id: string,
  tier: 0 | 1 | 2,
  initialBytes: number,
  options: { trimmable?: boolean } = {}
) {
  let bytes = initialBytes;
  let trimCalls: string[] = [];
  registerCache({
    id,
    tier,
    estimate: () => ({ bytes, entries: bytes > 0 ? 1 : 0 }),
    ...(options.trimmable === false
      ? {}
      : {
          trim: (level) => {
            trimCalls = [...trimCalls, level];
            bytes = level === "critical" ? 0 : Math.floor(bytes / 2);
          },
        }),
  });
  return {
    get bytes() {
      return bytes;
    },
    get trimCalls() {
      return trimCalls;
    },
  };
}

describe("cacheRegistry", () => {
  beforeEach(() => {
    __resetCacheRegistryForTests();
  });

  it("lists registered caches largest first with their estimates", () => {
    fakeCache("small", 0, 100);
    fakeCache("large", 1, 5_000);
    fakeCache("estimate-only", 1, 300, { trimmable: false });

    const reports = listRegisteredCaches();

    expect(reports.map((report) => report.id)).toEqual([
      "large",
      "estimate-only",
      "small",
    ]);
    expect(reports[0]).toMatchObject({
      tier: 1,
      bytes: 5_000,
      entries: 1,
      canTrim: true,
      lastTrimmedAt: null,
      estimateFailed: false,
    });
    expect(reports[1].canTrim).toBe(false);
  });

  it("unregisters only the registration that was handed back", () => {
    const unregisterFirst = registerCache({
      id: "dup",
      tier: 0,
      estimate: () => ({ bytes: 1 }),
    });
    registerCache({ id: "dup", tier: 0, estimate: () => ({ bytes: 2 }) });

    unregisterFirst();

    expect(listRegisteredCaches()).toHaveLength(1);
    expect(listRegisteredCaches()[0].bytes).toBe(2);
  });

  it("isolates a throwing estimator instead of failing the whole listing", () => {
    registerCache({
      id: "broken",
      tier: 0,
      estimate: () => {
        throw new Error("boom");
      },
    });
    fakeCache("healthy", 0, 10);

    const reports = listRegisteredCaches();

    expect(reports.find((report) => report.id === "broken")).toMatchObject({
      bytes: 0,
      entries: null,
      estimateFailed: true,
    });
    expect(reports.find((report) => report.id === "healthy")?.bytes).toBe(10);
  });

  it("moderate pressure trims tiers 0 and 1 only, lowest tier first", () => {
    const hidden = fakeCache("hidden-view", 2, 1_000);
    const replay = fakeCache("replay", 1, 1_000);
    const derived = fakeCache("derived", 0, 1_000);
    fakeCache("estimate-only", 0, 1_000, { trimmable: false });

    const results = trimRegisteredCaches("moderate", 42);

    expect(results.map((result) => result.id)).toEqual(["derived", "replay"]);
    expect(results[0]).toEqual({
      id: "derived",
      bytesBefore: 1_000,
      bytesAfter: 500,
      failed: false,
    });
    expect(derived.trimCalls).toEqual(["moderate"]);
    expect(replay.bytes).toBe(500);
    expect(hidden.bytes).toBe(1_000);
    expect(
      listRegisteredCaches().find((report) => report.id === "derived")
        ?.lastTrimmedAt
    ).toBe(42);
  });

  it("critical pressure trims every tier and reports a throwing trim", () => {
    const hidden = fakeCache("hidden-view", 2, 1_000);
    registerCache({
      id: "throws",
      tier: 0,
      estimate: () => ({ bytes: 7 }),
      trim: () => {
        throw new Error("cannot trim");
      },
    });

    const results = trimRegisteredCaches("critical");

    expect(hidden.bytes).toBe(0);
    expect(hidden.trimCalls).toEqual(["critical"]);
    expect(results.find((result) => result.id === "throws")).toEqual({
      id: "throws",
      bytesBefore: 7,
      bytesAfter: 7,
      failed: true,
    });
    expect(
      listRegisteredCaches().find((report) => report.id === "throws")
        ?.lastTrimmedAt
    ).toBeNull();
  });
});
