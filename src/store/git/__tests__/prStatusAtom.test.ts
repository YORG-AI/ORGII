import { describe, expect, it } from "vitest";

import type { OpenPRItem } from "@src/api/tauri/github/pullRequests";
import {
  PR_STATUS_CACHE_CONFIG,
  type RepoPrSnapshot,
  buildRepoPrSnapshot,
  isRepoPrStatusStale,
  pruneRepoPrStatusCache,
} from "@src/store/git/prStatusAtom";

function pr(overrides: Partial<OpenPRItem> & { head_branch: string }) {
  return {
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "PR",
    state: "open",
    author_login: "author",
    author_avatar_url: null,
    requested_reviewer_logins: [],
    base_branch: "main",
    draft: false,
    ci_status: "unavailable",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  } satisfies OpenPRItem;
}

describe("buildRepoPrSnapshot", () => {
  it("indexes each list response by head branch", () => {
    const snapshot = buildRepoPrSnapshot(
      {
        open: [pr({ head_branch: "feature-a", number: 10 })],
        closed: [pr({ head_branch: "feature-b", number: 4, state: "merged" })],
      },
      1000
    );

    expect(snapshot.fetchedAt).toBe(1000);
    expect(snapshot.byBranch.get("feature-a")?.status).toBe("open");
    expect(snapshot.byBranch.get("feature-b")).toMatchObject({
      status: "merged",
      number: 4,
    });
  });

  it("marks a draft PR as draft rather than open", () => {
    const snapshot = buildRepoPrSnapshot({
      open: [pr({ head_branch: "wip", draft: true })],
      closed: [],
    });
    expect(snapshot.byBranch.get("wip")?.status).toBe("draft");
  });

  it("lets a live open PR win over an older closed one on the same branch", () => {
    const snapshot = buildRepoPrSnapshot({
      open: [pr({ head_branch: "reused", number: 9 })],
      closed: [pr({ head_branch: "reused", number: 2, state: "closed" })],
    });
    expect(snapshot.byBranch.get("reused")).toMatchObject({
      status: "open",
      number: 9,
    });
  });

  it("keeps the newest PR when one response repeats a branch", () => {
    const snapshot = buildRepoPrSnapshot({
      open: [
        pr({ head_branch: "dup", number: 20 }),
        pr({ head_branch: "dup", number: 3 }),
      ],
      closed: [],
    });
    expect(snapshot.byBranch.get("dup")?.number).toBe(20);
  });

  it("keeps the newest repeat even when both entries normalize alike", () => {
    // Regression guard: deduping by comparing the stored NORMALIZED status
    // against the raw `state` let a second draft overwrite the newest one,
    // because a draft's raw state is "open".
    const snapshot = buildRepoPrSnapshot({
      open: [
        pr({ head_branch: "dup", number: 20, draft: true }),
        pr({ head_branch: "dup", number: 3, draft: true }),
      ],
      closed: [],
    });
    expect(snapshot.byBranch.get("dup")).toMatchObject({
      status: "draft",
      number: 20,
    });
  });

  it("caps retained branches so one busy repo cannot grow unbounded", () => {
    const many = Array.from(
      { length: PR_STATUS_CACHE_CONFIG.MAX_BRANCHES_PER_REPO + 25 },
      (_, index) => pr({ head_branch: `branch-${index}`, number: index })
    );
    const snapshot = buildRepoPrSnapshot({ open: many, closed: [] });
    expect(snapshot.byBranch.size).toBe(
      PR_STATUS_CACHE_CONFIG.MAX_BRANCHES_PER_REPO
    );
  });

  it("ignores entries with no head branch", () => {
    const snapshot = buildRepoPrSnapshot({
      open: [pr({ head_branch: "  " })],
      closed: [],
    });
    expect(snapshot.byBranch.size).toBe(0);
  });
});

describe("isRepoPrStatusStale", () => {
  const fresh: RepoPrSnapshot = { fetchedAt: 1000, byBranch: new Map() };

  it("treats a missing snapshot as stale", () => {
    expect(isRepoPrStatusStale(undefined, 1000)).toBe(true);
  });

  it("holds a snapshot until the TTL elapses", () => {
    expect(isRepoPrStatusStale(fresh, 1000 + 1)).toBe(false);
    expect(
      isRepoPrStatusStale(fresh, 1000 + PR_STATUS_CACHE_CONFIG.TTL_MS)
    ).toBe(true);
  });

  it("backs off a failed fetch until its retry time", () => {
    const failed: RepoPrSnapshot = {
      fetchedAt: 1000,
      byBranch: new Map(),
      error: true,
      retryAt: 9000,
    };
    expect(isRepoPrStatusStale(failed, 8999)).toBe(false);
    expect(isRepoPrStatusStale(failed, 9000)).toBe(true);
  });
});

describe("pruneRepoPrStatusCache", () => {
  function snapshot(fetchedAt: number): RepoPrSnapshot {
    return { fetchedAt, byBranch: new Map() };
  }

  it("drops repos that are no longer on screen", () => {
    const cache = new Map([
      ["o/keep", snapshot(1)],
      ["o/gone", snapshot(2)],
    ]);
    const pruned = pruneRepoPrStatusCache(cache, new Set(["o/keep"]));
    expect([...pruned.keys()]).toEqual(["o/keep"]);
  });

  it("evicts the least recently fetched once over the repo cap", () => {
    const repos = Array.from(
      { length: PR_STATUS_CACHE_CONFIG.MAX_REPOS + 3 },
      (_, index) => [`o/repo-${index}`, snapshot(index)] as const
    );
    const pruned = pruneRepoPrStatusCache(
      new Map(repos),
      new Set(repos.map(([name]) => name))
    );

    expect(pruned.size).toBe(PR_STATUS_CACHE_CONFIG.MAX_REPOS);
    // Highest `fetchedAt` values survive.
    expect(pruned.has(`o/repo-${repos.length - 1}`)).toBe(true);
    expect(pruned.has("o/repo-0")).toBe(false);
  });
});
