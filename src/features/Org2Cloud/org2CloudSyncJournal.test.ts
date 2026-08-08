// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import {
  SYNC_JOURNAL_CAP,
  clearSyncJournal,
  describeSyncError,
  getLastSyncState,
  getSyncJournalSnapshot,
  markSyncPass,
  recordSyncEvent,
  resetSyncJournalForTests,
  subscribeSyncJournal,
  useSyncJournal,
} from "./org2CloudSyncJournal";

beforeEach(() => {
  resetSyncJournalForTests();
});

afterEach(() => {
  resetSyncJournalForTests();
});

describe("sync journal buffer", () => {
  it("reads newest first and assigns deterministic monotonic ids", () => {
    recordSyncEvent({ level: "info", kind: "sync_pass", message: "first" });
    recordSyncEvent({ level: "warn", kind: "org_backoff", message: "second" });

    const snapshot = getSyncJournalSnapshot();
    expect(snapshot.map((entry) => entry.message)).toEqual(["second", "first"]);
    expect(snapshot.map((entry) => entry.id)).toEqual(["sync-2", "sync-1"]);
  });

  it("caps the ring buffer and evicts the oldest entries", () => {
    for (let index = 0; index < SYNC_JOURNAL_CAP + 25; index += 1) {
      recordSyncEvent({
        level: "info",
        kind: "sync_pass",
        message: `entry-${index}`,
      });
    }

    const snapshot = getSyncJournalSnapshot();
    expect(snapshot).toHaveLength(SYNC_JOURNAL_CAP);
    expect(snapshot[0]?.message).toBe(`entry-${SYNC_JOURNAL_CAP + 24}`);
    expect(snapshot[SYNC_JOURNAL_CAP - 1]?.message).toBe("entry-25");
  });

  it("keeps optional orgId/code off entries that do not carry them", () => {
    recordSyncEvent({ level: "error", kind: "sync_pass", message: "bare" });
    recordSyncEvent({
      level: "warn",
      kind: "org_backoff",
      message: "scoped",
      orgId: "org-1",
      code: "ORG2_QUOTA_EXCEEDED",
    });

    const [scoped, bare] = getSyncJournalSnapshot();
    expect(scoped?.orgId).toBe("org-1");
    expect(scoped?.code).toBe("ORG2_QUOTA_EXCEEDED");
    expect(bare && "orgId" in bare).toBe(false);
    expect(bare && "code" in bare).toBe(false);
  });

  it("stores a normalized member identity without retaining the input object", () => {
    const member = {
      userId: "  user-1  ",
      displayName: "  VantaNode  ",
    };
    recordSyncEvent({
      level: "warn",
      kind: "member_runtime",
      message: "push failed",
      member,
    });
    member.displayName = "changed later";

    expect(getSyncJournalSnapshot()[0]?.member).toEqual({
      userId: "user-1",
      displayName: "VantaNode",
    });
  });

  it("omits an unusable member identity instead of creating an empty filter", () => {
    recordSyncEvent({
      level: "warn",
      kind: "member_runtime",
      message: "push failed",
      member: { userId: "   ", displayName: "VantaNode" },
    });

    expect(getSyncJournalSnapshot()[0]).not.toHaveProperty("member");
  });

  it("clears entries and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSyncJournal(listener);
    recordSyncEvent({ level: "info", kind: "sync_pass", message: "x" });
    expect(listener).toHaveBeenCalledTimes(1);

    clearSyncJournal();
    expect(getSyncJournalSnapshot()).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(2);

    // Clearing an empty buffer is a no-op, so it must not re-notify.
    clearSyncJournal();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    recordSyncEvent({ level: "info", kind: "sync_pass", message: "y" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("describeSyncError", () => {
  it("reduces an Error to its message", () => {
    expect(describeSyncError(new Error("boom"))).toEqual({ message: "boom" });
  });

  it("carries the code off an Org2CloudSyncError-shaped error", () => {
    class SyncErrorLike extends Error {
      readonly code = "ORG2_QUOTA_EXCEEDED";
    }
    expect(describeSyncError(new SyncErrorLike("over quota"))).toEqual({
      message: "over quota",
      code: "ORG2_QUOTA_EXCEEDED",
    });
  });

  it("carries the code off a MemberRuntimeError-shaped error", () => {
    class RuntimeErrorLike extends Error {
      readonly code = "ORG2_RUNTIME_TOO_LARGE";
    }
    expect(describeSyncError(new RuntimeErrorLike("too big"))).toEqual({
      message: "too big",
      code: "ORG2_RUNTIME_TOO_LARGE",
    });
  });

  it("ignores a null code and a non-string code", () => {
    const nullCode = Object.assign(new Error("nope"), { code: null });
    expect(describeSyncError(nullCode)).toEqual({ message: "nope" });
    const numericCode = Object.assign(new Error("nope"), { code: 42 });
    expect(describeSyncError(numericCode)).toEqual({ message: "nope" });
  });

  it("stringifies non-Error values without retaining the object", () => {
    expect(describeSyncError("plain string")).toEqual({
      message: "plain string",
    });
    expect(describeSyncError({ message: "object message" })).toEqual({
      message: "object message",
    });
    expect(describeSyncError(undefined)).toEqual({ message: "undefined" });
    expect(describeSyncError(null)).toEqual({ message: "null" });
    // A value whose String() throws must still produce a flat string.
    const hostile = {
      toString() {
        throw new Error("nope");
      },
    };
    expect(describeSyncError(hostile).message).toBe("Unknown error");
  });

  it("clamps a pathologically long message", () => {
    const described = describeSyncError(new Error("x".repeat(5_000)));
    expect(described.message.length).toBe(500);
    expect(described.message.endsWith("…")).toBe(true);
  });

  it("never stores a raw object on a journal entry", () => {
    const error = Object.assign(new Error("wire failure"), {
      code: "ORG2_SYNC_DISABLED",
      response: { secret: "do-not-store" },
    });
    const described = describeSyncError(error);
    recordSyncEvent({
      level: "error",
      kind: "sync_pass",
      message: described.message,
      code: described.code,
    });

    const [entry] = getSyncJournalSnapshot();
    expect(entry).toEqual({
      id: "sync-1",
      atMs: expect.any(Number),
      level: "error",
      kind: "sync_pass",
      message: "wire failure",
      code: "ORG2_SYNC_DISABLED",
    });
    expect(JSON.stringify(entry)).not.toContain("do-not-store");
  });
});

describe("last-sync clock", () => {
  it("advances lastPassAtMs always and lastSuccessAtMs only on success", () => {
    expect(getLastSyncState()).toEqual({
      lastPassAtMs: null,
      lastSuccessAtMs: null,
    });

    markSyncPass({ success: true, atMs: 1_000 });
    expect(getLastSyncState()).toEqual({
      lastPassAtMs: 1_000,
      lastSuccessAtMs: 1_000,
    });

    markSyncPass({ success: false, atMs: 2_000 });
    expect(getLastSyncState()).toEqual({
      lastPassAtMs: 2_000,
      lastSuccessAtMs: 1_000,
    });
  });

  it("persists across a module reload but the entries do not", async () => {
    markSyncPass({ success: true, atMs: 4_242 });
    recordSyncEvent({ level: "info", kind: "sync_pass", message: "volatile" });

    vi.resetModules();
    const reloaded = await import("./org2CloudSyncJournal");

    expect(reloaded.getLastSyncState()).toEqual({
      lastPassAtMs: 4_242,
      lastSuccessAtMs: 4_242,
    });
    expect(reloaded.getSyncJournalSnapshot()).toHaveLength(0);
    reloaded.resetSyncJournalForTests();
  });
});

describe("useSyncJournal", () => {
  it("keeps a referentially stable snapshot and re-renders once per event", async () => {
    // Every render appends its snapshot; `snapshots.length` IS the render
    // count, so no ref bookkeeping is needed inside the component.
    const snapshots: (readonly unknown[])[] = [];

    function Probe() {
      const entries = useSyncJournal();
      snapshots.push(entries);
      return createElement(
        "div",
        { "data-testid": "count" },
        String(entries.length)
      );
    }

    const root = createSmokeRoot();
    try {
      await root.render(createElement(Probe));
      const rendersAfterMount = snapshots.length;
      const snapshotAfterMount = snapshots[snapshots.length - 1];

      // Same snapshot object across renders ⇒ useSyncExternalStore is stable.
      expect(getSyncJournalSnapshot()).toBe(snapshotAfterMount);

      await dispatch(() => {
        recordSyncEvent({
          level: "error",
          kind: "sync_pass",
          message: "first failure",
        });
      });
      expect(
        root.container.querySelector('[data-testid="count"]')?.textContent
      ).toBe("1");
      expect(snapshots.length).toBeGreaterThan(rendersAfterMount);

      await dispatch(() => {
        recordSyncEvent({
          level: "warn",
          kind: "org_backoff",
          message: "second failure",
          orgId: "org-1",
        });
      });
      expect(
        root.container.querySelector('[data-testid="count"]')?.textContent
      ).toBe("2");

      // The killer regression: an unstable snapshot loops forever. Bound the
      // total render count instead of asserting an exact React scheduling
      // detail.
      expect(snapshots.length).toBeLessThan(rendersAfterMount + 8);
    } finally {
      await root.unmount();
    }
  });
});
