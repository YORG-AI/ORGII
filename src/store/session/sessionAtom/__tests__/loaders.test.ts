/**
 * `mergeSessions` invariants.
 *
 * The sidebar paginated loader calls `mergeSessions(prev, incoming)` when a
 * "Load more" page lands so existing rows aren't blown away. Two contracts
 * matter:
 *  - rows already in `prev` whose ids are also in `incoming` are replaced
 *    by the incoming version (so a status change in the new page wins);
 *  - rows already in `prev` whose ids are NOT in `incoming` are kept;
 *  - the result is sorted by `updated_at desc`.
 */
import { describe, expect, it, vi } from "vitest";

import { __TESTS_ONLY } from "../loaders";
import type { Session } from "../types";

const {
  createSidebarLoadCoordinator,
  mergeSessions,
  replaceExternalHistorySourceFirstPage,
} = __TESTS_ONLY;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeSession(
  id: string,
  updatedAt: string,
  status = "completed"
): Session {
  return {
    session_id: id,
    status,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("mergeSessions", () => {
  it("returns a copy of prev when incoming is empty", () => {
    const prev = [makeSession("a", "2026-01-01")];
    const merged = mergeSessions(prev, []);
    expect(merged).toEqual(prev);
    expect(merged).not.toBe(prev);
  });

  it("keeps untouched prev rows additive", () => {
    const prev = [
      makeSession("a", "2026-01-02"),
      makeSession("b", "2026-01-01"),
    ];
    const incoming = [makeSession("c", "2026-01-03")];
    const merged = mergeSessions(prev, incoming);
    expect(merged.map((session) => session.session_id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("replaces matching ids with the incoming version", () => {
    const prev = [makeSession("a", "2026-01-02", "running")];
    const incoming = [makeSession("a", "2026-01-02", "completed")];
    const merged = mergeSessions(prev, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("completed");
  });

  it("sorts by updated_at desc", () => {
    const prev = [makeSession("a", "2026-01-01")];
    const incoming = [
      makeSession("b", "2026-01-03"),
      makeSession("c", "2026-01-02"),
    ];
    const merged = mergeSessions(prev, incoming);
    expect(merged.map((session) => session.session_id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("replaceExternalHistorySourceFirstPage", () => {
  const codexSource = {
    sourceId: "codex_app",
    listCategory: "external_history:codex_app",
    dispatchCategory: "external_history",
    prefix: "codexapp-",
    iconId: "codex",
    displayName: "Codex",
    groupLabel: "Codex App",
    listable: true,
    replayable: true,
  } as const;

  it("replaces only rows for the matching imported-history source", () => {
    const prev = [
      makeSession("codexapp-old", "2026-01-03"),
      makeSession("claudecodeapp-keep", "2026-01-02"),
      makeSession("cursoride-keep", "2026-01-01"),
    ];
    const incoming = [makeSession("codexapp-new", "2026-01-04")];

    const merged = replaceExternalHistorySourceFirstPage(
      prev,
      incoming,
      codexSource
    );

    expect(merged.map((session) => session.session_id)).toEqual([
      "codexapp-new",
      "claudecodeapp-keep",
      "cursoride-keep",
    ]);
  });
});

describe("sidebar load coordinator", () => {
  it("shares an active load with requests already covered by it", async () => {
    const active = deferred();
    const runner = vi.fn().mockReturnValue(active.promise);
    const load = createSidebarLoadCoordinator(runner);

    const first = load({ pageSize: 100, forceRefresh: true });
    const covered = load({ pageSize: 25 });

    expect(covered).toBe(first);
    expect(runner).toHaveBeenCalledOnce();

    active.resolve();
    await first;
    expect(runner).toHaveBeenCalledOnce();
  });

  it("merges stronger requests into one serialized follow-up pass", async () => {
    const active = deferred();
    const runner = vi
      .fn()
      .mockReturnValueOnce(active.promise)
      .mockResolvedValueOnce(undefined);
    const load = createSidebarLoadCoordinator(runner);

    const first = load({ pageSize: 25 });
    const larger = load({ pageSize: 100 });
    const forced = load({ pageSize: 50, forceRefresh: true });

    expect(larger).toBe(first);
    expect(forced).toBe(first);
    expect(runner).toHaveBeenCalledOnce();

    active.resolve();
    await first;

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[0]).toEqual({
      pageSize: 100,
      forceRefresh: true,
    });
  });

  it("resets after failure so a later load can retry", async () => {
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce(undefined);
    const load = createSidebarLoadCoordinator(runner);

    await expect(load()).rejects.toThrow("load failed");
    await expect(load({ forceRefresh: true })).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
