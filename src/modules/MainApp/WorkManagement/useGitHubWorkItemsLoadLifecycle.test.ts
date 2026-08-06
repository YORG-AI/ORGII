import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubRepoPermissions } from "@src/api/tauri/github";

import type { GitHubRepoSource } from "./githubWorkItemsTypes";
import {
  EMPTY_REPO_PRS,
  type GitHubWorkItemsLifecycleSnapshot,
  getGitHubLifecycleRetentionKey,
  loadRepoPermissions,
  retainGitHubWorkItemsLifecycleSnapshot,
} from "./useGitHubWorkItemsLoadLifecycle";

const mocks = vi.hoisted(() => ({
  getGitHubRepoPermissionsLocal: vi.fn(),
}));

vi.mock("@src/api/tauri/github", () => ({
  getGitHubRepoPermissionsLocal: mocks.getGitHubRepoPermissionsLocal,
  getGitHubViewerLogin: vi.fn(),
  listPRsLocal: vi.fn(),
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
    mocks.getGitHubRepoPermissionsLocal.mockReset();
    mocks.getGitHubRepoPermissionsLocal.mockResolvedValue(permissions);
  });

  it("shares one in-flight request per viewer and repository", async () => {
    const requests = new Map<string, Promise<GitHubRepoPermissions | null>>();

    const [first, second] = await Promise.all([
      loadRepoPermissions(source, "viewer", requests),
      loadRepoPermissions(source, "viewer", requests),
    ]);

    expect(first).toEqual([source.repoFullName, permissions]);
    expect(second).toEqual(first);
    expect(mocks.getGitHubRepoPermissionsLocal).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a permission request across viewer identities", async () => {
    const requests = new Map<string, Promise<GitHubRepoPermissions | null>>();

    await loadRepoPermissions(source, "viewer", requests);
    await loadRepoPermissions(source, "other-viewer", requests);

    expect(mocks.getGitHubRepoPermissionsLocal).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub work-item lifecycle retention", () => {
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
