import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubRepoPermissions } from "@src/api/tauri/github";
import { resetGitHubIssueDetailCoordinator } from "@src/modules/shared/githubIssueDetailCoordinator";

import type { GitHubRepoSource } from "./githubWorkItemsTypes";
import {
  EMPTY_REPO_ISSUES,
  EMPTY_REPO_PRS,
  type GitHubWorkItemsLifecycleSnapshot,
  getGitHubLifecycleRetentionKey,
  loadRepoPermissions,
  loadRepoPrs,
  mergeRepoIssueLoadResults,
  retainGitHubWorkItemsLifecycleSnapshot,
} from "./useGitHubWorkItemsLoadLifecycle";

const mocks = vi.hoisted(() => ({
  getGitHubRepoPermissionsLocal: vi.fn(),
  listPRsLocal: vi.fn(),
}));

vi.mock("@src/api/tauri/github", () => ({
  getGitHubRepoPermissionsLocal: mocks.getGitHubRepoPermissionsLocal,
  getGitHubViewerLogin: vi.fn(),
  listPRsLocal: mocks.listPRsLocal,
}));

const source: GitHubRepoSource = {
  repoId: "repo-1",
  repoPath: "/repo",
  label: "repo",
  remoteUrl: "https://github.com/acme/repo.git",
  repoFullName: "acme/repo",
  viewerLogin: "viewer",
  permissions: null,
};

const permissions: GitHubRepoPermissions = {
  role_name: "write",
  can_manage_issues: true,
  can_manage_pull_requests: true,
};

describe("GitHub work-item permission loading", () => {
  beforeEach(() => {
    resetGitHubIssueDetailCoordinator();
    mocks.getGitHubRepoPermissionsLocal.mockReset();
    mocks.getGitHubRepoPermissionsLocal.mockResolvedValue(permissions);
  });

  it("shares and retains one request per auth scope and repository", async () => {
    const store = createStore();

    const [first, second] = await Promise.all([
      loadRepoPermissions(store, source, "github.com:viewer"),
      loadRepoPermissions(store, source, "github.com:viewer"),
    ]);
    const third = await loadRepoPermissions(store, source, "github.com:viewer");

    expect(first).toEqual([source.repoFullName, permissions]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(mocks.getGitHubRepoPermissionsLocal).toHaveBeenCalledTimes(1);
  });

  it("does not reuse permissions across auth scopes", async () => {
    const store = createStore();

    await loadRepoPermissions(store, source, "github.com:viewer");
    await loadRepoPermissions(store, source, "github.com:other-viewer");

    expect(mocks.getGitHubRepoPermissionsLocal).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub work-item PR loading", () => {
  beforeEach(() => {
    mocks.listPRsLocal.mockReset();
    mocks.listPRsLocal.mockResolvedValue([]);
  });

  it("single-flights concurrent list loads and reuses the fresh result", async () => {
    const uniqueSource = {
      ...source,
      repoPath: `/repo-${crypto.randomUUID()}`,
    };

    const [first, second] = await Promise.all([
      loadRepoPrs(uniqueSource, "open", true),
      loadRepoPrs(uniqueSource, "open", true),
    ]);
    const cached = await loadRepoPrs(uniqueSource, "open", false);

    expect(first).toEqual(second);
    expect(cached).toEqual(first);
    expect(mocks.listPRsLocal).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub work-item lifecycle retention", () => {
  it("preserves cached issue lists for resolved repositories not loaded in the current pass", () => {
    const secondSource: GitHubRepoSource = {
      ...source,
      repoId: "repo-2",
      repoPath: "/repo-2",
      repoFullName: "acme/repo-2",
    };
    const cachedSecondState = {
      ...EMPTY_REPO_ISSUES,
      openLoaded: true,
    };
    const loadedFirstState = {
      ...EMPTY_REPO_ISSUES,
      closedLoaded: true,
    };

    const next = mergeRepoIssueLoadResults(
      {
        [source.repoFullName]: EMPTY_REPO_ISSUES,
        [secondSource.repoFullName]: cachedSecondState,
        "acme/removed-repo": EMPTY_REPO_ISSUES,
      },
      [source, secondSource],
      [{ source, ...loadedFirstState, error: null }]
    );

    expect(next).toEqual({
      [source.repoFullName]: loadedFirstState,
      [secondSource.repoFullName]: cachedSecondState,
    });
  });

  it("uses a stable scope key independent of repository input order", () => {
    const first = {
      id: "repo-1",
      name: "one",
      kind: "git",
      path: "/one",
      repo_url: "https://github.com/acme/one.git",
    } as const;
    const second = {
      id: "repo-2",
      name: "two",
      kind: "git",
      path: "/two",
      repo_url: "https://github.com/acme/two.git",
    } as const;

    expect(getGitHubLifecycleRetentionKey([first, second], "pr")).toBe(
      getGitHubLifecycleRetentionKey([second, first], "pr")
    );
    expect(getGitHubLifecycleRetentionKey([first], "pr")).not.toBe(
      getGitHubLifecycleRetentionKey([first], "issue")
    );
  });

  it("preserves references for unchanged revalidation results", () => {
    const current: GitHubWorkItemsLifecycleSnapshot = {
      viewerLogin: "viewer",
      repoSources: [source],
      repoIssueMap: {},
      repoPrMap: { [source.repoFullName]: EMPTY_REPO_PRS },
      loadError: null,
    };

    const next = retainGitHubWorkItemsLifecycleSnapshot({
      current,
      ...current,
      repoSources: [{ ...source }],
      repoPrMap: {
        [source.repoFullName]: { ...EMPTY_REPO_PRS },
      },
    });

    expect(next).toBe(current);
    expect(next.repoSources).toBe(current.repoSources);
    expect(next.repoPrMap).toBe(current.repoPrMap);
  });

  it("bounds the number of retained repositories", () => {
    const sources = Array.from({ length: 10 }, (_, index) => ({
      ...source,
      repoId: `repo-${index}`,
      repoPath: `/repo-${index}`,
      repoFullName: `acme/repo-${index}`,
    }));
    const repoPrMap = Object.fromEntries(
      sources.map((repoSource) => [repoSource.repoFullName, EMPTY_REPO_PRS])
    );

    const next = retainGitHubWorkItemsLifecycleSnapshot({
      viewerLogin: "viewer",
      repoSources: sources,
      repoIssueMap: {},
      repoPrMap,
      loadError: null,
    });

    expect(next.repoSources).toHaveLength(8);
    expect(Object.keys(next.repoPrMap)).toHaveLength(8);
  });
});
