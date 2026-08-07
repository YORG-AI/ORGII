import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWorkstationPrStorageKey,
  filterPullRequestsByQuery,
  formatWorkstationPrTitle,
  getStoredWorkstationPr,
  isWorkstationPrEligible,
  normalizePullRequestStatus,
  setStoredWorkstationPr,
  shouldAutoCreateWorkstationPr,
} from "../workstationPrHelpers";

describe("parseGithubRepoFullName", () => {
  it("parses SSH remotes", async () => {
    const { parseGithubRepoFullName } =
      await import("@src/services/git/operations/createPullRequest");
    expect(parseGithubRepoFullName("git@github.com:acme/app.git")).toBe(
      "acme/app"
    );
  });

  it("parses HTTPS remotes", async () => {
    const { parseGithubRepoFullName } =
      await import("@src/services/git/operations/createPullRequest");
    expect(parseGithubRepoFullName("https://github.com/acme/app")).toBe(
      "acme/app"
    );
  });

  it("returns null for unsupported remotes", async () => {
    const { parseGithubRepoFullName } =
      await import("@src/services/git/operations/createPullRequest");
    expect(parseGithubRepoFullName("not-a-remote-url")).toBeNull();
  });
});

describe("filterPullRequestsByQuery", () => {
  const pullRequests = [
    { number: 12, title: "Fix login bug" },
    { number: 34, title: "Add dark mode" },
  ];

  it("matches titles case-insensitively", () => {
    expect(filterPullRequestsByQuery(pullRequests, "DARK")).toEqual([
      pullRequests[1],
    ]);
  });

  it("matches PR numbers with or without a hash", () => {
    expect(filterPullRequestsByQuery(pullRequests, "12")).toEqual([
      pullRequests[0],
    ]);
    expect(filterPullRequestsByQuery(pullRequests, "#34")).toEqual([
      pullRequests[1],
    ]);
  });

  it("returns all pull requests for a blank query", () => {
    expect(filterPullRequestsByQuery(pullRequests, "   ")).toBe(pullRequests);
  });
});

describe("isWorkstationPrEligible", () => {
  it("returns true for a pushed feature branch with a clean tree", () => {
    expect(
      isWorkstationPrEligible({
        branch: "feat/pr",
        defaultBranch: "main",
        hasUpstream: true,
        uncommittedCount: 0,
      })
    ).toBe(true);
  });

  it("returns true even when tracking branch is fully in sync (ahead=0 relative to remote)", () => {
    // hasUpstream=true means the branch is pushed; we no longer gate on ahead count
    // because ahead tracks relative to the tracking branch, not the default branch
    expect(
      isWorkstationPrEligible({
        branch: "feat/pr",
        defaultBranch: "main",
        hasUpstream: true,
        uncommittedCount: 0,
      })
    ).toBe(true);
  });

  it("returns false on the default branch", () => {
    expect(
      isWorkstationPrEligible({
        branch: "main",
        defaultBranch: "main",
        hasUpstream: true,
        uncommittedCount: 0,
      })
    ).toBe(false);
  });

  it("returns false when there are uncommitted changes", () => {
    expect(
      isWorkstationPrEligible({
        branch: "feat/pr",
        defaultBranch: "main",
        hasUpstream: true,
        uncommittedCount: 3,
      })
    ).toBe(false);
  });

  it("returns false when branch has no upstream", () => {
    expect(
      isWorkstationPrEligible({
        branch: "feat/pr",
        defaultBranch: "main",
        hasUpstream: false,
        uncommittedCount: 0,
      })
    ).toBe(false);
  });

  it("returns false when branch is undefined", () => {
    expect(
      isWorkstationPrEligible({
        branch: undefined,
        defaultBranch: "main",
        hasUpstream: true,
        uncommittedCount: 0,
      })
    ).toBe(false);
  });
});

describe("shouldAutoCreateWorkstationPr", () => {
  it("auto-creates when enabled and eligible without an existing PR", () => {
    expect(
      shouldAutoCreateWorkstationPr({
        autoCreatePr: true,
        eligible: true,
        isCreating: false,
      })
    ).toBe(true);
  });

  it("does not auto-create when a PR already exists", () => {
    expect(
      shouldAutoCreateWorkstationPr({
        autoCreatePr: true,
        eligible: true,
        prUrl: "https://github.com/acme/app/pull/1",
        isCreating: false,
      })
    ).toBe(false);
  });

  it("does not auto-create while creation is already in progress", () => {
    expect(
      shouldAutoCreateWorkstationPr({
        autoCreatePr: true,
        eligible: true,
        isCreating: true,
      })
    ).toBe(false);
  });

  it("does not auto-create when autoCreatePr is disabled", () => {
    expect(
      shouldAutoCreateWorkstationPr({
        autoCreatePr: false,
        eligible: true,
        isCreating: false,
      })
    ).toBe(false);
  });
});

describe("formatWorkstationPrTitle", () => {
  it("uses the first commit line when available", () => {
    expect(formatWorkstationPrTitle("feat/x", "Fix login\n\nDetails")).toBe(
      "Fix login"
    );
  });

  it("falls back to branch name", () => {
    expect(formatWorkstationPrTitle("feat/x", "   ")).toBe("feat/x");
  });
});

describe("workstation PR storage", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, value);
      },
    });
  });

  it("round-trips PR records by repo and branch", () => {
    const key = buildWorkstationPrStorageKey("/repo", "feat/pr");
    expect(key).toContain("/repo");
    setStoredWorkstationPr("/repo", "feat/pr", {
      url: "https://github.com/acme/app/pull/2",
      status: "open",
    });
    expect(getStoredWorkstationPr("/repo", "feat/pr")).toMatchObject({
      url: "https://github.com/acme/app/pull/2",
      status: "open",
    });
  });
});

describe("normalizePullRequestStatus", () => {
  it("normalizes known GitHub states to lowercase", () => {
    expect(normalizePullRequestStatus("OPEN")).toBe("open");
    expect(normalizePullRequestStatus("merged")).toBe("merged");
    expect(normalizePullRequestStatus("CLOSED")).toBe("closed");
    expect(normalizePullRequestStatus("DRAFT")).toBe("draft");
  });

  it("passes through unknown states unchanged", () => {
    expect(normalizePullRequestStatus("pending_review")).toBe("pending_review");
  });

  it("returns undefined for null or empty input", () => {
    expect(normalizePullRequestStatus(null)).toBeUndefined();
    expect(normalizePullRequestStatus(undefined)).toBeUndefined();
  });
});
