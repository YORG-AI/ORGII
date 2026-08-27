/**
 * waitForSnapshotChange — unit tests
 *
 * These tests pin down the contract of the helper that replaced the leaky
 * inline `subscribe + setTimeout` pattern in `BranchNavigator.switchTo`.
 *
 * The bug being prevented:
 *   The previous code never called `unsub` on the timeout path, leaking a
 *   global EventStoreProxy listener every time a branch switch timed out.
 *
 * The tests below verify three contracts:
 *
 *   1. Listener IS unsubscribed on every resolution path:
 *      - snapshot arrives    → unsub called
 *      - timeout fires       → unsub called  ← the regression that mattered
 *      - signal aborts       → unsub called
 *      - already-changed     → no subscribe at all
 *
 *   2. Filtering: only snapshots for the requested session count, and the
 *      optional predicate gates further.
 *
 *   3. Race-window short-circuit: when `lastKnownVersion` is given and the
 *      cached snapshot has already advanced, the helper resolves without
 *      installing a listener (so a slow consumer can't miss the edge).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DerivedSnapshot,
  Snapshot,
} from "../../core/store/EventStoreProxy";
import {
  type SnapshotSubscriber,
  waitForSnapshotChange,
} from "../waitForSnapshotChange";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildSnapshot(version: number): DerivedSnapshot {
  return {
    version,
    eventCount: 0,
    events: [],
    chatEvents: [],
    messagesEvents: [],
    sortedSimulatorEvents: [],
    lastEvent: null,
    eventIndex: {},
    chatEventCount: 0,
    hasRunningEvent: false,
  };
}

interface FakeStore extends SnapshotSubscriber {
  /** Active listener set — exposed so tests can assert "no leaks". */
  readonly listeners: Set<(snapshot: Snapshot, sessionId: string) => void>;
  emit(snapshot: Snapshot, sessionId: string): void;
  setLatest(sessionId: string, snapshot: Snapshot | null): void;
}

function createFakeStore(): FakeStore {
  const listeners = new Set<(snapshot: Snapshot, sessionId: string) => void>();
  const latest = new Map<string, Snapshot>();

  return {
    listeners,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getLatestSessionSnapshot(sessionId) {
      return latest.get(sessionId) ?? null;
    },
    emit(snapshot, sessionId) {
      // Copy so iteration is stable even if listeners cleanup mid-emit.
      [...listeners].forEach((listener) => listener(snapshot, sessionId));
    },
    setLatest(sessionId, snapshot) {
      if (snapshot) {
        latest.set(sessionId, snapshot);
      } else {
        latest.delete(sessionId);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Vitest setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Resolution paths
// ---------------------------------------------------------------------------

describe("waitForSnapshotChange — happy path", () => {
  it("resolves with 'snapshot' when a matching session snapshot arrives", async () => {
    const store = createFakeStore();
    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 1000,
    });

    expect(store.listeners.size).toBe(1);

    store.emit(buildSnapshot(2), "s1");

    await expect(pending).resolves.toBe("snapshot");
    expect(store.listeners.size).toBe(0);
  });

  it("ignores snapshots for other sessions", async () => {
    const store = createFakeStore();
    const pending = waitForSnapshotChange(store, {
      sessionId: "target",
      timeoutMs: 500,
    });

    store.emit(buildSnapshot(7), "other-session");
    expect(store.listeners.size).toBe(1);

    store.emit(buildSnapshot(8), "target");
    await expect(pending).resolves.toBe("snapshot");
    expect(store.listeners.size).toBe(0);
  });
});

describe("waitForSnapshotChange — timeout path (REGRESSION GUARD)", () => {
  it("resolves with 'timeout' when no matching snapshot arrives", async () => {
    const store = createFakeStore();
    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 2000,
    });

    expect(store.listeners.size).toBe(1);

    vi.advanceTimersByTime(1999);
    expect(store.listeners.size).toBe(1);

    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toBe("timeout");
  });

  it("UNSUBSCRIBES the listener even when the timeout fires", async () => {
    // This is THE regression guard. The previous inline code only called
    // unsub() on the match path; on timeout the listener leaked forever.
    const store = createFakeStore();
    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 50,
    });

    expect(store.listeners.size).toBe(1);

    vi.advanceTimersByTime(50);
    await expect(pending).resolves.toBe("timeout");

    expect(store.listeners.size).toBe(0);
  });

  it("never resolves twice even if a late snapshot arrives after timeout", async () => {
    const store = createFakeStore();
    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 50,
    });

    vi.advanceTimersByTime(50);
    const first = await pending;
    expect(first).toBe("timeout");

    // Listener was already cleaned up — a late emit must not throw or
    // re-resolve, and must not re-add a listener.
    store.emit(buildSnapshot(99), "s1");
    expect(store.listeners.size).toBe(0);
  });
});

describe("waitForSnapshotChange — abort signal", () => {
  it("resolves with 'timeout' when the signal is aborted", async () => {
    const store = createFakeStore();
    const controller = new AbortController();
    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    expect(store.listeners.size).toBe(1);

    controller.abort();
    await expect(pending).resolves.toBe("timeout");
    expect(store.listeners.size).toBe(0);
  });

  it("resolves immediately when the signal is already aborted at call time", async () => {
    const store = createFakeStore();
    const controller = new AbortController();
    controller.abort();

    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    // No listener should ever be installed when the signal is pre-aborted.
    expect(store.listeners.size).toBe(0);
    await expect(pending).resolves.toBe("timeout");
  });
});

describe("waitForSnapshotChange — already-changed short-circuit", () => {
  it("resolves immediately when the cached snapshot is past lastKnownVersion", async () => {
    const store = createFakeStore();
    store.setLatest("s1", buildSnapshot(5));

    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 10_000,
      lastKnownVersion: 3,
    });

    // Critically, NO listener should have been installed.
    expect(store.listeners.size).toBe(0);
    await expect(pending).resolves.toBe("snapshot");
  });

  it("subscribes normally when cached snapshot is at or below the watermark", async () => {
    const store = createFakeStore();
    store.setLatest("s1", buildSnapshot(3));

    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 10_000,
      lastKnownVersion: 3,
    });

    expect(store.listeners.size).toBe(1);

    store.emit(buildSnapshot(4), "s1");
    await expect(pending).resolves.toBe("snapshot");
    expect(store.listeners.size).toBe(0);
  });

  it("does not short-circuit when no cached snapshot exists yet", async () => {
    const store = createFakeStore();
    // No setLatest call — first time the session is loaded.

    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 100,
      lastKnownVersion: 0,
    });

    expect(store.listeners.size).toBe(1);
    vi.advanceTimersByTime(100);
    await expect(pending).resolves.toBe("timeout");
    expect(store.listeners.size).toBe(0);
  });
});

describe("waitForSnapshotChange — predicate", () => {
  it("requires the predicate to return true even when the session matches", async () => {
    const store = createFakeStore();
    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 1000,
      predicate: (snap) => snap.version >= 10,
    });

    // Emit something matching the session but not the predicate.
    store.emit(buildSnapshot(5), "s1");
    expect(store.listeners.size).toBe(1);

    store.emit(buildSnapshot(11), "s1");
    await expect(pending).resolves.toBe("snapshot");
    expect(store.listeners.size).toBe(0);
  });

  it("respects the predicate on the already-changed short-circuit", async () => {
    const store = createFakeStore();
    // Cached snapshot exists but does NOT satisfy the predicate.
    store.setLatest("s1", buildSnapshot(8));

    const pending = waitForSnapshotChange(store, {
      sessionId: "s1",
      timeoutMs: 50,
      lastKnownVersion: 5,
      predicate: (snap) => snap.version >= 10,
    });

    // Listener must be installed because the cached snapshot didn't match.
    expect(store.listeners.size).toBe(1);
    vi.advanceTimersByTime(50);
    await expect(pending).resolves.toBe("timeout");
    expect(store.listeners.size).toBe(0);
  });
});

describe("waitForSnapshotChange — stress: many timeouts must not leak", () => {
  it("clears all listeners after 100 sequential timeouts", async () => {
    const store = createFakeStore();
    for (let i = 0; i < 100; i++) {
      const pending = waitForSnapshotChange(store, {
        sessionId: `s${i}`,
        timeoutMs: 10,
      });
      vi.advanceTimersByTime(10);
      await expect(pending).resolves.toBe("timeout");
    }
    expect(store.listeners.size).toBe(0);
  });

  it("clears all listeners after 100 sequential matches", async () => {
    const store = createFakeStore();
    for (let i = 0; i < 100; i++) {
      const pending = waitForSnapshotChange(store, {
        sessionId: `s${i}`,
        timeoutMs: 100,
      });
      store.emit(buildSnapshot(i + 1), `s${i}`);
      await expect(pending).resolves.toBe("snapshot");
    }
    expect(store.listeners.size).toBe(0);
  });

  it("does not leak when 50 concurrent waiters all time out", async () => {
    const store = createFakeStore();
    const pendings = Array.from({ length: 50 }, (_, i) =>
      waitForSnapshotChange(store, {
        sessionId: `concurrent-${i}`,
        timeoutMs: 25,
      })
    );

    expect(store.listeners.size).toBe(50);
    vi.advanceTimersByTime(25);
    await Promise.all(pendings);
    expect(store.listeners.size).toBe(0);
  });
});
