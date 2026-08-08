import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GitHubChecksSummary,
  LocalFindPRResponse,
} from "@src/api/tauri/github";

import {
  BRANCH_CI_EMPTY_POLL_MAX_ATTEMPTS,
  BRANCH_CI_EMPTY_POLL_MS,
  BRANCH_CI_POLL_BASE_MS,
  BRANCH_CI_POLL_MAX_MS,
  BRANCH_CI_SAFETY_POLL_MS,
  BRANCH_PULL_REQUEST_STATUS_CACHE_MAX_ENTRIES,
  BRANCH_PULL_REQUEST_STATUS_TTL_MS,
  branchPullRequestStatusCacheSize,
  buildBranchPullRequestStatusKey,
  buildGitHubCompareUrl,
  clearBranchPullRequestStatusCache,
  evictOtherBranchPullRequestStatusIdentities,
  getCachedBranchPullRequestStatus,
  isBranchPullRequestStatusFresh,
  loadBranchPullRequestStatusCoalesced,
  nextBranchCiPollDelayMs,
  resolveBranchCiStatus,
  setCachedBranchPullRequestStatus,
} from "./branchPullRequestStatus";

const pr: LocalFindPRResponse = {
  number: 42,
  state: "open",
  url: "https://github.com/acme/repo/pull/42",
};

function checks(
  state: GitHubChecksSummary["state"],
  populated = true
): GitHubChecksSummary {
  return {
    sha: "abc123",
    state,
    check_runs: populated
      ? [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: state,
            details_url: null,
            started_at: null,
            completed_at: null,
            output_title: null,
            app_name: "CI",
          },
        ]
      : [],
    statuses: [],
  };
}

describe("branch pull request status", () => {
  afterEach(() => {
    clearBranchPullRequestStatusCache();
    vi.useRealTimers();
  });

  it("cools terminal and no-PR states to the safety interval", () => {
    const base = { attempt: 0, checksUnavailable: false };

    // These states leave the fast loop but retain a remote-change fallback.
    expect(
      nextBranchCiPollDelayMs({ ...base, pr: null, checks: checks("pending") })
    ).toBe(BRANCH_CI_SAFETY_POLL_MS);
    expect(
      nextBranchCiPollDelayMs({
        ...base,
        pr,
        checks: null,
        checksUnavailable: true,
      })
    ).toBe(BRANCH_CI_SAFETY_POLL_MS);
    expect(
      nextBranchCiPollDelayMs({ ...base, pr, checks: checks("success") })
    ).toBe(BRANCH_CI_SAFETY_POLL_MS);
    expect(
      nextBranchCiPollDelayMs({ ...base, pr, checks: checks("failure") })
    ).toBe(BRANCH_CI_SAFETY_POLL_MS);
  });

  it("backs off while checks run and caps the interval", () => {
    const running = { checks: checks("pending"), checksUnavailable: false, pr };

    expect(nextBranchCiPollDelayMs({ ...running, attempt: 0 })).toBe(
      BRANCH_CI_POLL_BASE_MS
    );
    expect(nextBranchCiPollDelayMs({ ...running, attempt: 1 })).toBe(
      BRANCH_CI_POLL_BASE_MS * 2
    );
    expect(nextBranchCiPollDelayMs({ ...running, attempt: 9 })).toBe(
      BRANCH_CI_POLL_MAX_MS
    );
  });

  it("gives an unreported PR a bounded grace period before giving up", () => {
    const empty = {
      checks: checks("pending", false),
      checksUnavailable: false,
      pr,
    };

    expect(nextBranchCiPollDelayMs({ ...empty, attempt: 0 })).toBe(
      BRANCH_CI_EMPTY_POLL_MS
    );
    expect(
      nextBranchCiPollDelayMs({
        ...empty,
        attempt: BRANCH_CI_EMPTY_POLL_MAX_ATTEMPTS - 1,
      })
    ).toBe(BRANCH_CI_EMPTY_POLL_MS);
    expect(
      nextBranchCiPollDelayMs({
        ...empty,
        attempt: BRANCH_CI_EMPTY_POLL_MAX_ATTEMPTS,
      })
    ).toBe(BRANCH_CI_SAFETY_POLL_MS);
  });

  it("builds GitHub compare links and falls back to the compare picker", () => {
    expect(buildGitHubCompareUrl("acme/repo", "main", "feature/a")).toBe(
      "https://github.com/acme/repo/compare/main...feature%2Fa"
    );
    expect(buildGitHubCompareUrl("acme/repo", "main", "main")).toBe(
      "https://github.com/acme/repo/compare"
    );
  });

  it("maps populated checks and empty CI results to visible states", () => {
    expect(
      resolveBranchCiStatus({
        pr,
        checks: checks("success"),
        checksUnavailable: false,
        loading: false,
      })
    ).toBe("success");
    expect(
      resolveBranchCiStatus({
        pr,
        checks: checks("failure"),
        checksUnavailable: false,
        loading: false,
      })
    ).toBe("failure");
    expect(
      resolveBranchCiStatus({
        pr,
        checks: checks("pending"),
        checksUnavailable: false,
        loading: false,
      })
    ).toBe("pending");
    expect(
      resolveBranchCiStatus({
        pr,
        checks: checks("success", false),
        checksUnavailable: false,
        loading: false,
      })
    ).toBe("none");
  });

  it("distinguishes loading and unavailable checks for a linked PR", () => {
    expect(
      resolveBranchCiStatus({
        pr,
        checks: null,
        checksUnavailable: false,
        loading: true,
      })
    ).toBe("checking");
    expect(
      resolveBranchCiStatus({
        pr,
        checks: null,
        checksUnavailable: true,
        loading: false,
      })
    ).toBe("unavailable");
    expect(
      resolveBranchCiStatus({
        pr: null,
        checks: null,
        checksUnavailable: false,
        loading: false,
      })
    ).toBeNull();
  });

  it("bounds the cache and expires entries after the status TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));

    for (
      let index = 0;
      index < BRANCH_PULL_REQUEST_STATUS_CACHE_MAX_ENTRIES + 1;
      index += 1
    ) {
      setCachedBranchPullRequestStatus(`key-${index}`, {
        pr,
        checks: checks("success"),
        checksUnavailable: false,
      });
    }

    expect(branchPullRequestStatusCacheSize()).toBe(
      BRANCH_PULL_REQUEST_STATUS_CACHE_MAX_ENTRIES
    );
    expect(getCachedBranchPullRequestStatus("key-0")).toBeNull();
    const newest = getCachedBranchPullRequestStatus(
      `key-${BRANCH_PULL_REQUEST_STATUS_CACHE_MAX_ENTRIES}`
    );
    expect(isBranchPullRequestStatusFresh(newest)).toBe(true);

    vi.advanceTimersByTime(BRANCH_PULL_REQUEST_STATUS_TTL_MS + 1);
    expect(isBranchPullRequestStatusFresh(newest)).toBe(false);
  });

  it("coalesces branch-status requests and evicts prior auth identities", async () => {
    const loader = vi.fn(async () => ({
      pr,
      checks: checks("success"),
      checksUnavailable: false,
    }));
    const key = buildBranchPullRequestStatusKey({
      authScope: "connection-a",
      repoFullName: "acme/repo",
      branchName: "feature",
    });

    const first = loadBranchPullRequestStatusCoalesced(key, loader);
    const second = loadBranchPullRequestStatusCoalesced(key, loader);
    expect(second).toBe(first);
    await first;
    expect(loader).toHaveBeenCalledTimes(1);

    setCachedBranchPullRequestStatus(key, await loader());
    const nextIdentityKey = buildBranchPullRequestStatusKey({
      authScope: "connection-b",
      repoFullName: "acme/repo",
      branchName: "feature",
    });
    setCachedBranchPullRequestStatus(nextIdentityKey, await loader());
    evictOtherBranchPullRequestStatusIdentities({
      activeAuthScope: "connection-b",
      repoFullName: "acme/repo",
    });

    expect(getCachedBranchPullRequestStatus(key)).toBeNull();
    expect(getCachedBranchPullRequestStatus(nextIdentityKey)).not.toBeNull();
  });
});
