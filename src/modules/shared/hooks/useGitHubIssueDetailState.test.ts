// @vitest-environment jsdom
// Exercises the shared controller through its real Jotai state boundary.
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { GitHubIssue } from "@src/api/tauri/github";
import {
  githubIssueResourceKey,
  resetGitHubIssueDetailCoordinator,
} from "@src/modules/shared/githubIssueDetailCoordinator";
import { workstationSelectedIssueAtomFamily } from "@src/store/workstation/codeEditor/workstationIssueAtom";

import {
  resolveGitHubIssueRepoFullName,
  useGitHubIssueDetailState,
} from "./useGitHubIssueDetailState";

const mocks = vi.hoisted(() => ({
  createIssueCommentLocal: vi.fn(),
  getGitHubRepoPermissionsLocal: vi.fn(),
  getGitHubViewerLogin: vi.fn(),
  fetchIssue: vi.fn(),
  fetchIssueTimeline: vi.fn(),
  listIssueTimelineLocal: vi.fn(),
  listIssuesLocal: vi.fn(),
  listRepoAssigneesLocal: vi.fn(),
  updateIssueLocal: vi.fn(),
}));

vi.mock("@src/api/tauri/github", () => mocks);

vi.mock("@src/services/git/operations/githubIssues", () => ({
  fetchIssue: mocks.fetchIssue,
  fetchIssueTimeline: mocks.fetchIssueTimeline,
  issueCommentToTimelineItem: vi.fn(),
}));

const issue: GitHubIssue = {
  id: 100_132,
  number: 132,
  title: "Use one issue surface",
  body: "Share the Inbox composer.",
  state: "open",
  state_reason: null,
  html_url: "https://github.com/org2AI/ORG2/issues/132",
  created_at: "2026-08-05T01:00:00.000Z",
  updated_at: "2026-08-05T02:00:00.000Z",
  closed_at: null,
  user: {
    login: "viewer",
    avatar_url: "https://example.com/viewer.png",
  },
  labels: [],
  assignees: [],
  comments: 0,
  milestone: null,
};

function Probe() {
  const { interaction, assigneeConfig } = useGitHubIssueDetailState({
    issueNumber: issue.number,
    repoPath: "/repos/ORG2",
    stateScopeKey: "issue-detail-test",
    authScope: "test-auth",
  });

  return createElement(
    "div",
    {
      "data-testid": "issue-detail-state",
      "data-loading": String(interaction.loading),
      "data-viewer": interaction.viewer?.login,
      "data-duplicate-count": String(interaction.duplicateCandidates.length),
      "data-assignee-disabled": String(assigneeConfig?.disabled),
      "data-assignee-options": String(assigneeConfig?.options.length ?? 0),
      "data-assignees": assigneeConfig?.currentAssigneeIds.join(","),
    },
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "load-duplicates-twice",
        onClick: () => {
          void interaction.onLoadDuplicateCandidates();
          void interaction.onLoadDuplicateCandidates();
        },
      },
      "Load duplicates"
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "load-assignees",
        onClick: () => void assigneeConfig?.onOpen?.(),
      },
      "Load assignees"
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "assign-collaborator",
        onClick: () =>
          void assigneeConfig?.onChangeAssigneeIds(["collaborator"]),
      },
      "Assign collaborator"
    )
  );
}

function ColdProbe({ stateScopeKey }: { stateScopeKey: string }) {
  const { selectedState } = useGitHubIssueDetailState({
    issueNumber: issue.number,
    repoPath: "/repos/ORG2",
    remoteUrl: "git@github.com:org2AI/ORG2.git",
    stateScopeKey,
    authScope: "test-auth",
  });
  return createElement("div", {
    "data-testid": stateScopeKey,
    "data-loading": String(selectedState.loading),
  });
}

describe("useGitHubIssueDetailState", () => {
  let container: HTMLDivElement;
  let root: Root;
  const store = createStore();
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetGitHubIssueDetailCoordinator(store);
    mocks.getGitHubViewerLogin.mockResolvedValue("viewer");
    mocks.fetchIssue.mockResolvedValue({ data: issue });
    mocks.fetchIssueTimeline.mockResolvedValue({ data: [] });
    mocks.getGitHubRepoPermissionsLocal.mockResolvedValue({
      role_name: "write",
      can_manage_issues: true,
      can_manage_pull_requests: false,
    });
    mocks.listRepoAssigneesLocal.mockResolvedValue([]);
    store.set(workstationSelectedIssueAtomFamily("issue-detail-test"), {
      resourceKey: githubIssueResourceKey(
        "test-auth",
        "org2AI/ORG2",
        issue.number
      ),
      issue,
      timeline: [],
      loading: false,
      timelineLoading: false,
      error: null,
      submittingComment: false,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("resolves only repository-shaped remotes and GitHub issue URLs", () => {
    expect(resolveGitHubIssueRepoFullName("org2AI/ORG2", undefined)).toBe(
      "org2AI/ORG2"
    );
    expect(
      resolveGitHubIssueRepoFullName(
        "git@github.com:org2AI/ORG2.git",
        undefined
      )
    ).toBe("org2AI/ORG2");
    expect(resolveGitHubIssueRepoFullName(undefined, issue.html_url)).toBe(
      "org2AI/ORG2"
    );
    expect(
      resolveGitHubIssueRepoFullName(
        undefined,
        "https://github.com/org2AI/ORG2/pull/132"
      )
    ).toBeNull();
  });

  it("loads identity without eagerly loading duplicate candidates", async () => {
    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(Probe)));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='issue-detail-state']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });

    expect(
      container
        .querySelector("[data-testid='issue-detail-state']")
        ?.getAttribute("data-viewer")
    ).toBe("viewer");
    expect(mocks.getGitHubRepoPermissionsLocal).toHaveBeenCalledWith(
      "org2AI/ORG2"
    );
    expect(mocks.listIssuesLocal).not.toHaveBeenCalled();
  });

  it("single-flights cold detail, timeline, viewer, and permission reads across hosts", async () => {
    await act(async () => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(ColdProbe, { stateScopeKey: "cold-host-a" }),
          createElement(ColdProbe, { stateScopeKey: "cold-host-b" })
        )
      );
    });

    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='cold-host-a']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });
    expect(mocks.fetchIssue).toHaveBeenCalledOnce();
    expect(mocks.fetchIssueTimeline).toHaveBeenCalledOnce();
    expect(mocks.getGitHubViewerLogin).toHaveBeenCalledOnce();
    expect(mocks.getGitHubRepoPermissionsLocal).toHaveBeenCalledOnce();
  });

  it("single-flights concurrent duplicate-candidate requests", async () => {
    let resolveCandidates:
      | ((value: {
          issues: GitHubIssue[];
          total_count: number;
          has_more: boolean;
          next_page: null;
        }) => void)
      | undefined;
    mocks.listIssuesLocal.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCandidates = resolve;
        })
    );

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(Probe)));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='issue-detail-state']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='load-duplicates-twice']"
        )
        ?.click();
    });
    expect(mocks.listIssuesLocal).toHaveBeenCalledOnce();

    await act(async () => {
      resolveCandidates?.({
        issues: [
          issue,
          { ...issue, id: 100_987, number: 987, title: "Canonical issue" },
        ],
        total_count: 2,
        has_more: false,
        next_page: null,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='issue-detail-state']")
          ?.getAttribute("data-duplicate-count")
      ).toBe("1");
    });
  });

  it("loads and updates assignees when repository permissions allow it", async () => {
    const collaborator = {
      login: "collaborator",
      avatar_url: "https://example.com/collaborator.png",
    };
    mocks.listRepoAssigneesLocal.mockResolvedValue([collaborator]);
    mocks.updateIssueLocal.mockResolvedValue({
      ...issue,
      assignees: [collaborator],
    });

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(Probe)));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='issue-detail-state']")
          ?.getAttribute("data-assignee-disabled")
      ).toBe("false");
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='load-assignees']")
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.listRepoAssigneesLocal).toHaveBeenCalledWith("org2AI/ORG2");
      expect(
        container
          .querySelector("[data-testid='issue-detail-state']")
          ?.getAttribute("data-assignee-options")
      ).toBe("1");
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='assign-collaborator']")
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.updateIssueLocal).toHaveBeenCalledWith(
        "org2AI/ORG2",
        issue.number,
        { assignees: ["collaborator"] }
      );
      expect(
        container
          .querySelector("[data-testid='issue-detail-state']")
          ?.getAttribute("data-assignees")
      ).toBe("collaborator");
    });
  });

  it("single-flights assignee updates and ignores completion after the issue scope changes", async () => {
    const collaborator = {
      login: "collaborator",
      avatar_url: "https://example.com/collaborator.png",
    };
    let resolveUpdate: ((value: GitHubIssue) => void) | undefined;
    mocks.updateIssueLocal.mockImplementation(
      () =>
        new Promise<GitHubIssue>((resolve) => {
          resolveUpdate = resolve;
        })
    );

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(Probe)));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='issue-detail-state']")
          ?.getAttribute("data-assignee-disabled")
      ).toBe("false");
    });

    act(() => {
      const assign = container.querySelector<HTMLButtonElement>(
        "[data-testid='assign-collaborator']"
      );
      assign?.click();
      assign?.click();
    });
    expect(mocks.updateIssueLocal).toHaveBeenCalledOnce();

    const otherIssue: GitHubIssue = {
      ...issue,
      id: 200_132,
      title: "Different repository issue",
      html_url: "https://github.com/acme/other/issues/132",
      assignees: [],
    };
    act(() => {
      store.set(workstationSelectedIssueAtomFamily("issue-detail-test"), {
        resourceKey: githubIssueResourceKey(
          "test-auth",
          "acme/other",
          otherIssue.number
        ),
        issue: otherIssue,
        timeline: [],
        loading: false,
        timelineLoading: false,
        error: null,
        submittingComment: false,
      });
    });

    await act(async () => {
      resolveUpdate?.({ ...issue, assignees: [collaborator] });
      await Promise.resolve();
    });

    expect(
      store.get(workstationSelectedIssueAtomFamily("issue-detail-test")).issue
    ).toEqual(otherIssue);
  });
});
