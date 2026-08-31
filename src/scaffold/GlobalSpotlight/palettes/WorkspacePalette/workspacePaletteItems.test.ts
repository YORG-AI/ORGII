import { describe, expect, it, vi } from "vitest";

import type { CachedRepo } from "@src/store/repo";
import { REPO_KIND } from "@src/store/repo";

import type { RepoItem, SpotlightItem } from "../../types";
import type { WorkspacePaletteText } from "./types";
import { buildSectionedWorkspaceItems } from "./workspacePaletteItems";

const paletteText: WorkspacePaletteText = {
  switchPathLabel: "Switch",
  switchPathTemplate: "Switch",
  switchPlaceholder: "Search",
  invalidPathTitle: "Invalid",
  invalidPathMessage: (path: string) => `Invalid: ${path}`,
  addPathLabel: "Add",
  addPathTemplate: "Add",
  addPlaceholder: "Add",
  addEntryLabel: "More",
  openFolderLabel: "Open folder",
  addFolderLabel: "Add folder",
  sectionCurrentLabel: "Current",
  sectionRecentLabel: "Recent",
  sectionSystemPathsLabel: "System Paths",
  sectionExternalRecentLabel: "Used elsewhere",
  sectionRepoLabel: "Repositories",
  sectionFolderWorkspaceLabel: "Workspace",
  sectionMultiRepoWorkspaceLabel: "Multi-Repo Workspace",
  sectionThisOrgLabel: "This org",
  sectionOutsideOrgLabel: "Outside this org",
};

const gitRepo = (id: string): RepoItem => ({
  id,
  name: id,
  fs_uri: `/repos/${id}`,
  kind: REPO_KIND.GIT,
});

const folderRepo = (id: string): RepoItem => ({
  id,
  name: id,
  fs_uri: `/folders/${id}`,
  kind: REPO_KIND.FOLDER,
});

const systemPathRepo = (): RepoItem => ({
  id: "__orgii_system_path__:home",
  name: "Home",
  fs_uri: "/Users/someone",
  kind: REPO_KIND.FOLDER,
});

const recentCached = (ids: string[]): CachedRepo[] =>
  ids.map((id) => ({ id, name: id, path: `/repos/${id}` }));

const workspaceItem = (
  id: string,
  outsideOrgScope: boolean
): SpotlightItem => ({
  id: `workspace-${id}`,
  label: id,
  type: "repo",
  data: {
    isCurrentSelection: false,
    outsideOrgScope,
    updatedAt: "2026-01-01T00:00:00Z",
  },
  action: () => {},
});

/** Slice the flat item list into sections keyed by header id. */
function bySection(items: SpotlightItem[]): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current = "(none)";
  for (const item of items) {
    const headerMatch = /^__header_repo_(.+)__$/.exec(item.id);
    if (headerMatch && item.data?.isHeader) {
      current = headerMatch[1];
      sections[current] = [];
    } else {
      (sections[current] ??= []).push(item.id);
    }
  }
  return sections;
}

function build(
  overrides: Partial<Parameters<typeof buildSectionedWorkspaceItems>[0]> = {}
) {
  return buildSectionedWorkspaceItems({
    addMenuActive: false,
    sectionedAddItems: [],
    workspaceItems: [],
    openPathItem: null,
    filteredRepos: [],
    isMultiRoot: false,
    isManageMode: false,
    selectedIds: new Set(),
    searchQuery: "",
    paletteText,
    onRepoAction: () => {},
    onLeadingRepoAction: () => {},
    toggleSelection: () => {},
    ...overrides,
  });
}

describe("buildSectionedWorkspaceItems org scope grouping", () => {
  it("keeps the plain repo/workspace sections when no org scope is active", () => {
    // Three ranked cached repos fill the top-3 Recent pool so the workspace
    // item stays in its own section instead of being pulled into Recent.
    const sections = bySection(
      build({
        filteredRepos: [
          gitRepo("repo-a"),
          gitRepo("repo-b"),
          gitRepo("recent-1"),
          gitRepo("recent-2"),
          gitRepo("recent-3"),
        ],
        recentCachedRepos: recentCached(["recent-1", "recent-2", "recent-3"]),
        workspaceItems: [workspaceItem("ws-1", false)],
      })
    );

    expect(sections.recent).toEqual(["recent-1", "recent-2", "recent-3"]);
    expect(sections.repo).toEqual(["repo-a", "repo-b"]);
    expect(sections.multiRepoWorkspace).toEqual(["workspace-ws-1"]);
    expect(sections.thisOrg).toBeUndefined();
    expect(sections.outsideOrg).toBeUndefined();
  });

  it("groups rows into This org / Outside this org instead of hiding them", () => {
    const inOrg = new Set([
      "repo-in",
      "repo-current",
      "recent-1",
      "recent-2",
      "recent-3",
    ]);
    const sections = bySection(
      build({
        filteredRepos: [
          gitRepo("repo-current"),
          gitRepo("repo-in"),
          gitRepo("repo-out"),
          folderRepo("folder-out"),
          gitRepo("recent-1"),
          gitRepo("recent-2"),
          gitRepo("recent-3"),
        ],
        recentCachedRepos: recentCached(["recent-1", "recent-2", "recent-3"]),
        workspaceItems: [
          workspaceItem("ws-in", false),
          workspaceItem("ws-out", true),
        ],
        currentRepoId: "repo-current",
        orgScopeFilter: (repo) => inOrg.has(repo.id),
      })
    );

    expect(sections.current).toEqual(["repo-current"]);
    expect(sections.thisOrg).toEqual(["repo-in", "workspace-ws-in"]);
    expect(sections.outsideOrg).toEqual([
      "repo-out",
      "workspace-ws-out",
      "folder-out",
    ]);
    expect(sections.repo).toBeUndefined();
    expect(sections.multiRepoWorkspace).toBeUndefined();
    expect(sections.folderWorkspace).toBeUndefined();
  });

  it("keeps system-path rows in their own section without running the org predicate on them", () => {
    const orgScopeFilter = vi.fn(() => false);
    const sections = bySection(
      build({
        filteredRepos: [gitRepo("repo-out"), systemPathRepo()],
        leadingRepos: [systemPathRepo()],
        orgScopeFilter,
      })
    );

    expect(sections.systemPath).toEqual(["__orgii_system_path__:home"]);
    expect(sections.outsideOrg).toContain("repo-out");
    expect(orgScopeFilter).toHaveBeenCalledWith(
      expect.objectContaining({ id: "repo-out" })
    );
    expect(orgScopeFilter).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "__orgii_system_path__:home" })
    );
  });

  it("keeps out-of-org rows selectable", () => {
    const onRepoAction = vi.fn();
    const items = build({
      filteredRepos: [gitRepo("repo-out")],
      orgScopeFilter: () => false,
      onRepoAction,
    });

    const outsideItem = items.find((item) => item.id === "repo-out");
    expect(outsideItem).toBeDefined();
    outsideItem?.action?.();
    expect(onRepoAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "repo-out" })
    );
  });

  it("scopes Recent to the org: out-of-org recents fall to Outside this org", () => {
    const sections = bySection(
      build({
        filteredRepos: [gitRepo("repo-in"), gitRepo("repo-out")],
        recentCachedRepos: recentCached(["repo-out", "repo-in"]),
        orgScopeFilter: (repo) => repo.id === "repo-in",
      })
    );

    expect(sections.recent).toEqual(["repo-in"]);
    expect(sections.outsideOrg).toEqual(["repo-out"]);
    expect(sections.thisOrg).toBeUndefined();
  });

  it("keeps out-of-org workspaces out of Recent under an org scope", () => {
    const sections = bySection(
      build({
        filteredRepos: [gitRepo("repo-in")],
        workspaceItems: [
          workspaceItem("ws-in", false),
          workspaceItem("ws-out", true),
        ],
        orgScopeFilter: (repo) => repo.id === "repo-in",
      })
    );

    expect(sections.recent).toEqual(["workspace-ws-in"]);
    expect(sections.outsideOrg).toEqual(["workspace-ws-out"]);
  });
});
