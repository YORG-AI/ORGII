import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLoadedPayloads,
  getLoadedPayload,
  getLoadedPayloadStats,
  getPendingPayloadLoad,
  markPayloadLoaded,
  trackPendingPayloadLoad,
} from "./loadedPayloadRegistry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("loaded payload lifecycle bounds", () => {
  beforeEach(() => {
    clearLoadedPayloads();
  });

  afterEach(() => {
    clearLoadedPayloads();
    vi.useRealTimers();
  });

  it("enforces both byte budget and least-recently-used eviction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const threeMiBUtf16 = "x".repeat((3 * 1024 * 1024) / 2);

    markPayloadLoaded("oldest", threeMiBUtf16);
    vi.setSystemTime(2_000);
    markPayloadLoaded("middle", threeMiBUtf16);
    vi.setSystemTime(3_000);
    markPayloadLoaded("newest", threeMiBUtf16);

    expect(getLoadedPayload("oldest")).toBeNull();
    expect(getLoadedPayload("middle")).toBe(threeMiBUtf16);
    expect(getLoadedPayload("newest")).toBe(threeMiBUtf16);
    expect(getLoadedPayloadStats()).toEqual({
      entries: 2,
      bytes: 6 * 1024 * 1024,
    });
  });

  it("expires payload bodies after the three-minute idle TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    markPayloadLoaded("payload", "body");

    vi.setSystemTime(10_000 + 3 * 60 * 1_000 - 1);
    expect(getLoadedPayload("payload")).toBe("body");

    vi.setSystemTime(10_000 + 6 * 60 * 1_000 - 1);
    expect(getLoadedPayload("payload")).toBeNull();
    expect(getLoadedPayloadStats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("cannot repopulate the cache from a request released by switch or close", async () => {
    const load = deferred<string | null>();
    const tracked = trackPendingPayloadLoad("stale", load.promise);
    expect(getPendingPayloadLoad("stale")).toBe(load.promise);

    clearLoadedPayloads();
    load.resolve("late body");

    await expect(tracked).resolves.toBe("late body");
    expect(getLoadedPayload("stale")).toBeNull();
    expect(getPendingPayloadLoad("stale")).toBeNull();
  });

  it("a superseded completion cannot delete or overwrite the newer load", async () => {
    const older = deferred<string | null>();
    const newer = deferred<string | null>();
    const olderTracked = trackPendingPayloadLoad("same-key", older.promise);
    const newerTracked = trackPendingPayloadLoad("same-key", newer.promise);

    older.resolve("older body");
    await olderTracked;
    expect(getPendingPayloadLoad("same-key")).toBe(newer.promise);
    expect(getLoadedPayload("same-key")).toBeNull();

    newer.resolve("newer body");
    await newerTracked;
    expect(getPendingPayloadLoad("same-key")).toBeNull();
    expect(getLoadedPayload("same-key")).toBe("newer body");
  });
});
