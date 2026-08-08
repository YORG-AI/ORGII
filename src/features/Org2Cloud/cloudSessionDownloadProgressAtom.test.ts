import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import {
  type CloudSessionDownloadProgress,
  cloudDownloadEtaMs,
  cloudDownloadPercent,
  cloudSessionDownloadProgressAtom,
  completeCloudDownloadProgressWithLinger,
  createThrottledProgressReporter,
  formatCloudDownloadEta,
  upsertCloudSessionDownloadProgressAtom,
} from "./cloudSessionDownloadProgressAtom";

function progress(
  overrides: Partial<CloudSessionDownloadProgress> = {}
): CloudSessionDownloadProgress {
  return {
    rowId: "org:owner:session",
    orgId: "org",
    loadedEvents: 500,
    totalEvents: 1000,
    startedAtMs: 10_000,
    updatedAtMs: 20_000,
    phase: "downloading",
    ...overrides,
  };
}

describe("cloudDownloadPercent", () => {
  it("computes the floor percent", () => {
    expect(cloudDownloadPercent(progress())).toBe(50);
    expect(cloudDownloadPercent(progress({ loadedEvents: 999 }))).toBe(99);
  });

  it("clamps to 99 while the download is still running", () => {
    // 100 only ever comes from the entry disappearing (import finished).
    expect(cloudDownloadPercent(progress({ loadedEvents: 1000 }))).toBe(99);
    expect(cloudDownloadPercent(progress({ loadedEvents: 2000 }))).toBe(99);
  });

  it("returns null without a known total", () => {
    expect(cloudDownloadPercent(progress({ totalEvents: null }))).toBeNull();
    expect(cloudDownloadPercent(progress({ totalEvents: 0 }))).toBeNull();
  });
});

describe("cloudDownloadEtaMs", () => {
  it("projects the remaining time from the average rate", () => {
    // 500 events over 10s => 50/s => 500 remaining => 10s.
    expect(cloudDownloadEtaMs(progress())).toBe(10_000);
  });

  it("is null before anything meaningful was observed", () => {
    expect(cloudDownloadEtaMs(progress({ loadedEvents: 0 }))).toBeNull();
    expect(cloudDownloadEtaMs(progress({ totalEvents: null }))).toBeNull();
    expect(cloudDownloadEtaMs(progress({ updatedAtMs: 10_200 }))).toBeNull();
  });
});

describe("formatCloudDownloadEta", () => {
  it("formats compact locale-neutral durations", () => {
    expect(formatCloudDownloadEta(900)).toBe("1s");
    expect(formatCloudDownloadEta(8_000)).toBe("8s");
    expect(formatCloudDownloadEta(80_000)).toBe("1m20s");
    expect(formatCloudDownloadEta(120_000)).toBe("2m");
    expect(formatCloudDownloadEta(2 * 3_600_000 + 5 * 60_000)).toBe("2h05m");
  });
});

describe("createThrottledProgressReporter", () => {
  const payload = (
    loadedEvents: number,
    phase: "downloading" | "finalizing" | "paused" = "downloading"
  ) => ({
    localSessionId: "imported-session-abc",
    progress: {
      rowId: "row-1",
      orgId: "org-1",
      loadedEvents,
      totalEvents: 4450,
      startedAtMs: 0,
      updatedAtMs: loadedEvents,
      phase,
    },
  });

  it("coalesces burst ticks into leading + trailing writes", async () => {
    vi.useFakeTimers();
    try {
      const writes: number[] = [];
      const reporter = createThrottledProgressReporter(
        (p) => writes.push(p.progress.loadedEvents),
        150
      );
      reporter.report(payload(1));
      reporter.report(payload(2));
      reporter.report(payload(3));
      expect(writes).toEqual([1]);
      vi.advanceTimersByTime(150);
      expect(writes).toEqual([1, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes non-downloading phases immediately and drops parked ticks", () => {
    vi.useFakeTimers();
    try {
      const writes: Array<[number, string]> = [];
      const reporter = createThrottledProgressReporter(
        (p) => writes.push([p.progress.loadedEvents, p.progress.phase]),
        150
      );
      reporter.report(payload(1));
      reporter.report(payload(2));
      reporter.report(payload(3, "finalizing"));
      expect(writes).toEqual([
        [1, "downloading"],
        [3, "finalizing"],
      ]);
      vi.advanceTimersByTime(300);
      expect(writes.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() drops the trailing tick", () => {
    vi.useFakeTimers();
    try {
      const writes: number[] = [];
      const reporter = createThrottledProgressReporter(
        (p) => writes.push(p.progress.loadedEvents),
        150
      );
      reporter.report(payload(1));
      reporter.report(payload(2));
      reporter.cancel();
      vi.advanceTimersByTime(300);
      expect(writes).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("completeCloudDownloadProgressWithLinger", () => {
  const seed = (store: ReturnType<typeof createStore>, startedAtMs: number) => {
    store.set(upsertCloudSessionDownloadProgressAtom, {
      localSessionId: "imported-session-abc",
      progress: {
        rowId: "row-1",
        orgId: "org-1",
        loadedEvents: 4000,
        totalEvents: 4450,
        startedAtMs,
        updatedAtMs: startedAtMs + 100,
        phase: "downloading",
      },
    });
  };

  it("holds a completed 100% entry until the minimum window elapses", () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      seed(store, Date.now() - 1_000);
      completeCloudDownloadProgressWithLinger(
        store,
        "imported-session-abc",
        3_000
      );
      const held = store
        .get(cloudSessionDownloadProgressAtom)
        .get("imported-session-abc");
      expect(held?.phase).toBe("completed");
      expect(held?.loadedEvents).toBe(4450);
      expect(cloudDownloadPercent(held!)).toBe(100);
      vi.advanceTimersByTime(1_900);
      expect(
        store.get(cloudSessionDownloadProgressAtom).has("imported-session-abc")
      ).toBe(true);
      vi.advanceTimersByTime(200);
      expect(
        store.get(cloudSessionDownloadProgressAtom).has("imported-session-abc")
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears immediately when the surface was already visible long enough", () => {
    const store = createStore();
    seed(store, Date.now() - 10_000);
    completeCloudDownloadProgressWithLinger(
      store,
      "imported-session-abc",
      3_000
    );
    expect(
      store.get(cloudSessionDownloadProgressAtom).has("imported-session-abc")
    ).toBe(false);
  });

  it("never reaps an entry a newer download replaced", () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      seed(store, Date.now() - 1_000);
      completeCloudDownloadProgressWithLinger(
        store,
        "imported-session-abc",
        3_000
      );
      seed(store, Date.now());
      vi.advanceTimersByTime(5_000);
      const survivor = store
        .get(cloudSessionDownloadProgressAtom)
        .get("imported-session-abc");
      expect(survivor?.phase).toBe("downloading");
    } finally {
      vi.useRealTimers();
    }
  });
});
