// @vitest-environment jsdom
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

import type {
  GitHubIssue,
  GitHubIssueTimelineItem,
} from "@src/api/tauri/github";
import { resetGitHubIssueDetailCoordinator } from "@src/modules/shared/githubIssueDetailCoordinator";

import {
  type TeamInboxGitHubIssueState,
  useTeamInboxGitHubIssue,
} from "../useTeamInboxGitHubIssue";

const mocks = vi.hoisted(() => ({
  createIssueCommentLocal: vi.fn(),
  getGitHubRepoPermissionsLocal: vi.fn(),
  getGitHubViewerLogin: vi.fn(),
  getGitCredentialForRemote: vi.fn(),
  getIssueLocal: vi.fn(),
  fetchIssue: vi.fn(),
  fetchIssueTimeline: vi.fn(),
  listIssuesLocal: vi.fn(),
  listIssueTimelineLocal: vi.fn(),
  listRepoAssigneesLocal: vi.fn(),
  updateIssueLocal: vi.fn(),
}));

vi.mock("@src/api/tauri/github", () => mocks);

vi.mock("@src/services/git/operations/githubIssues", () => ({
  fetchIssue: mocks.fetchIssue,
  fetchIssueTimeline: mocks.fetchIssueTimeline,
  issueCommentToTimelineItem: (comment: {
    id: number;
    body: string;
    user: { login: string; avatar_url: string };
    created_at: string;
    html_url: string;
  }) => ({
    id: comment.id,
    event: "commented",
    created_at: comment.created_at,
    actor: comment.user,
    body: comment.body,
    html_url: comment.html_url,
    assignee: null,
    label: null,
    milestone: null,
    rename: null,
    source: null,
    commit_id: null,
    lock_reason: null,
  }),
}));

const issue: GitHubIssue = {
  id: 100_132,
  number: 132,
  title: "Use the inline GitHub composer",
  body: "Keep the entire issue thread together.",
  state: "open",
  state_reason: null,
  html_url: "https://github.com/org2AI/ORG2/issues/132",
  created_at: "2026-08-05T01:00:00.000Z",
  updated_at: "2026-08-05T02:00:00.000Z",
  closed_at: null,
  user: {
    login: "issue-author",
    avatar_url: "https://example.com/issue-author.png",
  },
  labels: [],
  assignees: [],
  comments: 1,
  milestone: null,
};

const timelineItem: GitHubIssueTimelineItem = {
  id: 1,
  event: "commented",
  created_at: "2026-08-05T02:00:00.000Z",
  actor: {
    login: "viewer",
    avatar_url: "https://example.com/viewer.png",
  },
  body: "Existing comment",
  html_url: "https://github.com/org2AI/ORG2/issues/132#issuecomment-1",
  assignee: null,
  label: null,
  milestone: null,
  rename: null,
  source: null,
  commit_id: null,
  lock_reason: null,
};

function Probe({
  onStatusChanged,
}: {
  onStatusChanged: (state: GitHubIssue["state"]) => void;
}) {
  const state: TeamInboxGitHubIssueState = useTeamInboxGitHubIssue({
    enabled: true,
    repoFullName: "org2AI/ORG2",
    issueNumber: 132,
    fallbackState: "open",
    onStatusChanged,
  });
  return createElement(
    "div",
    {
      "data-testid": "github-issue-probe",
      "data-loading": String(state.timelineLoading),
      "data-comments": String(state.timeline.length),
      "data-viewer": state.interaction.viewer?.login,
      "data-viewer-avatar": state.interaction.viewer?.avatar_url,
      "data-can-comment": String(state.interaction.canComment),
      "data-can-edit-body": String(state.interaction.canEditBody),
      "data-can-manage": String(state.interaction.canManageStatus),
      "data-state": state.interaction.issueState,
      "data-body": state.issue?.body ?? "",
      "data-author": state.issue?.user.login,
      "data-duplicate-count": String(
        state.interaction.duplicateCandidates.length
      ),
    },
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "add-comment",
        onClick: () =>
          void state.interaction.onAddComment("New inline comment"),
      },
      "Add"
    ),
    createElement(
      "button",
      {
        type: "button",
        disabled: !state.interaction.canManageStatus,
        "data-testid": "close-issue",
        onClick: () => void state.interaction.onStatusChange("closed"),
      },
      "Close"
    ),
    createElement(
      "button",
      {
        type: "button",
        disabled: !state.interaction.canEditBody,
        "data-testid": "update-body",
        onClick: () =>
          void state.interaction.onUpdateBody("Updated issue description"),
      },
      "Update body"
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "load-duplicate-candidates",
        onClick: () => void state.interaction.onLoadDuplicateCandidates(),
      },
      "Load duplicate candidates"
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "close-as-duplicate",
        onClick: () =>
          void state.interaction.onStatusChange("closed", {
            stateReason: "duplicate",
            duplicateIssueId: 100_987,
          }),
      },
      "Close as duplicate"
    )
  );
}

describe("useTeamInboxGitHubIssue", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetGitHubIssueDetailCoordinator();
    mocks.getIssueLocal.mockResolvedValue(issue);
    mocks.listIssueTimelineLocal.mockResolvedValue([timelineItem]);
    mocks.fetchIssue.mockResolvedValue({ data: issue });
    mocks.fetchIssueTimeline.mockResolvedValue({ data: [timelineItem] });
    mocks.getGitCredentialForRemote.mockResolvedValue({
      connection_id: "test-connection",
      source: "connection",
      username: "viewer",
      token: "discarded-test-token",
    });
    mocks.getGitHubViewerLogin.mockResolvedValue("viewer");
    mocks.getGitHubRepoPermissionsLocal.mockResolvedValue({
      role_name: "write",
      can_manage_issues: true,
      can_manage_pull_requests: false,
    });
    mocks.listIssuesLocal.mockResolvedValue({
      issues: [],
      total_count: 0,
      has_more: false,
      next_page: null,
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

  it("loads the active GitHub profile, issue, timeline, and permissions", async () => {
    await act(async () => {
      root.render(createElement(Probe, { onStatusChanged: vi.fn() }));
    });

    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });

    const probe = container.querySelector("[data-testid='github-issue-probe']");
    expect(probe?.getAttribute("data-viewer")).toBe("viewer");
    expect(probe?.getAttribute("data-viewer-avatar")).toBe(
      "https://example.com/viewer.png"
    );
    expect(probe?.getAttribute("data-can-comment")).toBe("true");
    expect(probe?.getAttribute("data-can-edit-body")).toBe("true");
    expect(probe?.getAttribute("data-can-manage")).toBe("true");
    expect(probe?.getAttribute("data-author")).toBe("issue-author");
    expect(mocks.getGitHubViewerLogin).toHaveBeenCalledOnce();
    expect(mocks.getGitHubRepoPermissionsLocal).toHaveBeenCalledWith(
      "org2AI/ORG2"
    );
    expect(mocks.listIssuesLocal).not.toHaveBeenCalled();
  });

  it("loads duplicate candidates only after opening that flow and reuses the result", async () => {
    mocks.listIssuesLocal.mockResolvedValue({
      issues: [
        issue,
        {
          ...issue,
          id: 100_987,
          number: 987,
          title: "Canonical issue",
        },
      ],
      total_count: 2,
      has_more: false,
      next_page: null,
    });

    await act(async () => {
      root.render(createElement(Probe, { onStatusChanged: vi.fn() }));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });
    expect(mocks.listIssuesLocal).not.toHaveBeenCalled();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='load-duplicate-candidates']"
        )
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-duplicate-count")
      ).toBe("1");
    });
    expect(mocks.listIssuesLocal).toHaveBeenCalledOnce();
    expect(mocks.listIssuesLocal).toHaveBeenCalledWith("org2AI/ORG2", {
      state: "all",
      page: 1,
      perPage: 100,
      includeLinkedPullRequests: false,
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='load-duplicate-candidates']"
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.listIssuesLocal).toHaveBeenCalledOnce();
  });

  it("adds comments inline and closes the issue through GitHub", async () => {
    const onStatusChanged = vi.fn();
    mocks.createIssueCommentLocal.mockResolvedValue({
      id: 2,
      body: "New inline comment",
      user: timelineItem.actor,
      created_at: "2026-08-05T03:00:00.000Z",
      updated_at: "2026-08-05T03:00:00.000Z",
      html_url: "https://github.com/org2AI/ORG2/issues/132#issuecomment-2",
    });
    mocks.updateIssueLocal.mockResolvedValue({
      ...issue,
      state: "closed",
      state_reason: "completed",
    });

    await act(async () => {
      root.render(createElement(Probe, { onStatusChanged }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='add-comment']")
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.createIssueCommentLocal).toHaveBeenCalledWith(
      "org2AI/ORG2",
      132,
      "New inline comment"
    );
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-comments")
      ).toBe("2");
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='close-issue']")
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.updateIssueLocal).toHaveBeenCalledWith("org2AI/ORG2", 132, {
      state: "closed",
      stateReason: "completed",
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-state")
      ).toBe("closed");
    });
    expect(onStatusChanged).toHaveBeenCalledWith("closed");
  });

  it("updates the issue body through GitHub and reconciles the loaded issue", async () => {
    mocks.updateIssueLocal.mockResolvedValue({
      ...issue,
      body: "Updated issue description",
      updated_at: "2026-08-05T04:00:00.000Z",
    });

    await act(async () => {
      root.render(createElement(Probe, { onStatusChanged: vi.fn() }));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='update-body']")
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.updateIssueLocal).toHaveBeenCalledWith("org2AI/ORG2", 132, {
      body: "Updated issue description",
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-body")
      ).toBe("Updated issue description");
    });
  });

  it("does not expose status mutation without author or repository permission", async () => {
    mocks.getGitHubRepoPermissionsLocal.mockResolvedValue({
      role_name: "read",
      can_manage_issues: false,
      can_manage_pull_requests: false,
    });

    await act(async () => {
      root.render(createElement(Probe, { onStatusChanged: vi.fn() }));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-can-manage")
      ).toBe("false");
    });
    expect(
      container
        .querySelector("[data-testid='github-issue-probe']")
        ?.getAttribute("data-can-edit-body")
    ).toBe("false");
    expect(
      container.querySelector<HTMLButtonElement>("[data-testid='close-issue']")
        ?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>("[data-testid='update-body']")
        ?.disabled
    ).toBe(true);
    expect(mocks.updateIssueLocal).not.toHaveBeenCalled();
  });

  it("allows the issue author to edit the body without repository-wide permission", async () => {
    mocks.getGitHubViewerLogin.mockResolvedValue("ISSUE-AUTHOR");
    mocks.getGitHubRepoPermissionsLocal.mockResolvedValue({
      role_name: "read",
      can_manage_issues: false,
      can_manage_pull_requests: false,
    });

    await act(async () => {
      root.render(createElement(Probe, { onStatusChanged: vi.fn() }));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-can-edit-body")
      ).toBe("true");
    });

    expect(
      container.querySelector<HTMLButtonElement>("[data-testid='update-body']")
        ?.disabled
    ).toBe(false);
  });

  it("passes the selected canonical database ID to GitHub", async () => {
    mocks.updateIssueLocal.mockResolvedValue({
      ...issue,
      state: "closed",
      state_reason: "duplicate",
    });

    await act(async () => {
      root.render(createElement(Probe, { onStatusChanged: vi.fn() }));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='github-issue-probe']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='close-as-duplicate']")
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.updateIssueLocal).toHaveBeenCalledWith("org2AI/ORG2", 132, {
      state: "closed",
      stateReason: "duplicate",
      duplicateIssueId: 100_987,
    });
  });
});
