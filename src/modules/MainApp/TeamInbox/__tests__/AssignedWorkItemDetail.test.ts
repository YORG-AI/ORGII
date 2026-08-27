// @vitest-environment jsdom
import { Chrome, SquareArrowOutUpRight } from "lucide-react";
import React, { act, createElement } from "react";
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

import type { WorkItem } from "@src/types/core/workItem";

import AssignedWorkItemDetail from "../components/AssignedWorkItemDetail";
import type { AssignedWorkItem } from "../domain";

const mocks = vi.hoisted(() => ({
  detailLayoutProps: null as Record<string, unknown> | null,
  threadWorkItem: null as WorkItem | null,
  threadProps: null as Record<string, unknown> | null,
  getGitRemotes: vi.fn(async () => ({
    remotes: [
      {
        name: "origin",
        url: "git@github.com:org2AI/ORG2.git",
        fetch_url: "git@github.com:org2AI/ORG2.git",
      },
    ],
  })),
  githubIssueState: {
    issue: null as Record<string, unknown> | null,
    timeline: [{ event: "assigned" }],
    timelineLoading: false,
    interaction: {
      viewer: {
        login: "github-viewer",
        avatar_url: "https://example.com/github-viewer.png",
      },
      issueState: "open" as const,
      duplicateCandidates: [],
      duplicateCandidatesLoaded: false,
      loadingDuplicateCandidates: false,
      duplicateCandidatesError: false,
      loading: false,
      canComment: true,
      canEditBody: true,
      canManageStatus: true,
      submittingComment: false,
      updatingBody: false,
      updatingStatus: false,
      error: null,
      onAddComment: vi.fn(),
      onUpdateBody: vi.fn(),
      onLoadDuplicateCandidates: vi.fn(),
      onStatusChange: vi.fn(),
    },
  },
  openExternalLink: vi.fn(async () => undefined),
  updateWorkItem: vi.fn(),
  transitionHandoff: vi.fn(),
  workItem: {
    session_id: "work-item-1",
    user_id: "member-2",
    name: "Add Team Inbox",
    status: "backlog",
    spec: "Build the reusable feature surface.",
    star: false,
    target_date: null,
    created_time: "2026-07-23T10:00:00.000Z",
    updated_time: "2026-07-23T10:00:00.000Z",
    todos: [],
    linkedSessions: [],
    orchestratorConfig: {
      review_enabled: true,
      follow_up_enabled: true,
      auto_retry_on_failure: false,
      max_retry_count: 1,
      auto_create_pr: false,
      selected_account_id: "account-1",
      selected_model_id: "model-1",
    },
  } as WorkItem,
}));

vi.mock("@src/api/http/git/remotes", () => ({
  getGitRemotes: mocks.getGitRemotes,
}));

vi.mock("@src/util/platform/ipcRenderer", () => ({
  openExternalLink: mocks.openExternalLink,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../useTeamInboxWorkItem", () => ({
  useTeamInboxWorkItem: () => ({
    workItem: mocks.workItem,
    status: "ready",
    issue: null,
    repoPath: "/repo",
    members: [],
    currentUser: {
      id: "user-ea821852",
      name: "hanafish",
      avatar: "https://example.com/hanafish.png",
      color: "#52c41a",
    },
    updateWorkItem: mocks.updateWorkItem,
    transitionHandoff: mocks.transitionHandoff,
    refreshWorkItem: vi.fn(),
  }),
}));

vi.mock("../useTeamInboxGitHubIssue", () => ({
  useTeamInboxGitHubIssue: () => mocks.githubIssueState,
}));

vi.mock("@src/modules/ProjectManager/WorkItems/components", () => ({
  WorkItemThreadSurface: ({
    workItem,
    onOpenSession,
    propertyProps,
    onUpdateWorkItem,
    onTransitionHandoff,
    currentUser,
    ...threadProps
  }: {
    workItem: WorkItem;
    onOpenSession?: (sessionId: string) => void;
    propertyProps?: Record<string, unknown>;
    onUpdateWorkItem?: (updates: Partial<WorkItem>) => void;
    onTransitionHandoff?: (transition: {
      handoffId: string;
      action: "accept";
      actor: { id: string; name: string };
    }) => Promise<WorkItem>;
    currentUser?: { id: string; name: string; avatar?: string };
    githubIssueTimeline?: unknown;
    githubIssueInteraction?: unknown;
  }) => {
    mocks.threadWorkItem = workItem;
    mocks.threadProps = { ...threadProps, propertyProps };
    return createElement(
      "div",
      {
        "data-testid": "work-item-content",
        "data-current-user-id": currentUser?.id,
        "data-current-user-name": currentUser?.name,
        "data-current-user-avatar": currentUser?.avatar,
      },
      propertyProps
        ? createElement("div", {
            "data-testid": "work-item-properties",
            "data-property-configured": "true",
          })
        : null,
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "open-session",
          onClick: () => onOpenSession?.("session-1"),
        },
        "Open session"
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "set-status",
          onClick: () => onUpdateWorkItem?.({ workItemStatus: "in_progress" }),
        },
        "Set status"
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "accept-handoff",
          onClick: () =>
            void onTransitionHandoff?.({
              handoffId: "handoff-1",
              action: "accept",
              actor: { id: "member-2", name: "Lin" },
            }),
        },
        "Accept handoff"
      )
    );
  },
}));

vi.mock("../components/TeamInboxDetailLayout", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.detailLayoutProps = props;
    return createElement("div", null, props.children as React.ReactNode);
  },
}));

const item: AssignedWorkItem = {
  id: "work-item-1",
  kind: "assigned_work_item",
  occurredAt: "2026-07-23T10:00:00.000Z",
  readAt: null,
  actor: { id: "member-2", displayName: "Lin" },
  target: {
    kind: "work_item",
    projectId: "project-1",
    workItemId: "work-item-1",
  },
  payload: {
    title: "Add Team Inbox",
    status: "in_progress",
    priority: "high",
    assigneeMemberId: "member-2",
    updatedAt: "2026-07-23T10:00:00.000Z",
  },
};

describe("AssignedWorkItemDetail navigation actions", () => {
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
    mocks.detailLayoutProps = null;
    mocks.threadWorkItem = null;
    mocks.threadProps = null;
    mocks.githubIssueState.issue = null;
    mocks.githubIssueState.timelineLoading = false;
    mocks.githubIssueState.interaction.loading = false;
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

  it("shows separate browser and Work Item actions for GitHub-backed items", async () => {
    const onNavigate = vi.fn();
    const githubItem: AssignedWorkItem = {
      ...item,
      target: {
        ...item.target,
        repository: "git@github.com:org2AI/ORG2.git",
        workItemId: "42",
      },
      payload: { ...item.payload, status: "open" },
    };

    await act(async () => {
      root.render(
        createElement(AssignedWorkItemDetail, {
          item: githubItem,
          onNavigate,
        })
      );
      await Promise.resolve();
    });

    expect(mocks.detailLayoutProps?.openLabel).toBe(
      "teamInbox.actions.openWorkItem"
    );
    const openIcon = mocks.detailLayoutProps?.openIcon;
    expect(React.isValidElement(openIcon)).toBe(true);
    expect((openIcon as React.ReactElement).type).toBe(SquareArrowOutUpRight);
    const browserAction = mocks.detailLayoutProps?.headerAuxiliaryAction as
      | {
          label: string;
          icon: React.ReactElement;
          onClick: () => void;
          testId: string;
        }
      | undefined;
    expect(browserAction?.label).toBe("previews.openInExternalBrowser");
    expect(browserAction?.icon.type).toBe(Chrome);
    expect(browserAction?.testId).toBe("team-inbox-open-github");
    const headerContent = mocks.detailLayoutProps?.headerContent;
    expect(React.isValidElement(headerContent)).toBe(true);
    expect(
      (headerContent as React.ReactElement<{ issue: unknown }>).props.issue
    ).toEqual({
      number: 42,
      state: "open",
      title: "Add Team Inbox",
    });

    act(() => {
      browserAction?.onClick();
    });

    expect(mocks.openExternalLink).toHaveBeenCalledWith(
      "https://github.com/org2AI/ORG2/issues/42"
    );
    expect(onNavigate).not.toHaveBeenCalled();

    act(() => {
      (mocks.detailLayoutProps?.onOpen as (() => void) | undefined)?.();
    });
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "open_work_item",
      projectId: "project-1",
      workItemId: "42",
    });
  });

  it("resolves the local Git remote when repository metadata is unavailable", async () => {
    const githubItem: AssignedWorkItem = {
      ...item,
      target: {
        ...item.target,
        workItemId: "61",
      },
      payload: { ...item.payload, status: "open" },
    };

    await act(async () => {
      root.render(
        createElement(AssignedWorkItemDetail, {
          item: githubItem,
          onNavigate: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const headerContent = mocks.detailLayoutProps?.headerContent;
    expect(React.isValidElement(headerContent)).toBe(true);
    expect(
      (headerContent as React.ReactElement<{ issue: unknown }>).props.issue
    ).toEqual({
      number: 61,
      state: "open",
      title: "Add Team Inbox",
    });
    expect(mocks.detailLayoutProps?.openLabel).toBe(
      "teamInbox.actions.openWorkItem"
    );
    expect(mocks.getGitRemotes).toHaveBeenCalledWith({
      repo_id: "default",
      repo_path: "/repo",
    });
    const browserAction = mocks.detailLayoutProps?.headerAuxiliaryAction as
      | { label: string; onClick: () => void }
      | undefined;
    expect(browserAction?.label).toBe("previews.openInExternalBrowser");
    act(() => browserAction?.onClick());
    expect(mocks.openExternalLink).toHaveBeenCalledWith(
      "https://github.com/org2AI/ORG2/issues/61"
    );
  });

  it("loads the GitHub issue opener for the description timeline", async () => {
    const githubItem: AssignedWorkItem = {
      ...item,
      target: {
        ...item.target,
        repository: "git@github.com:org2AI/ORG2.git",
        workItemId: "132",
      },
      payload: { ...item.payload, status: "open" },
    };

    mocks.githubIssueState.issue = {
      title: "Authoritative title",
      body: "Authoritative GitHub description",
      state: "open",
      updated_at: "2026-08-05T03:00:00.000Z",
      user: {
        login: "github-author",
        avatar_url: "https://example.com/github-author.png",
      },
    };

    await act(async () => {
      root.render(createElement(AssignedWorkItemDetail, { item: githubItem }));
      await Promise.resolve();
    });

    expect(mocks.threadWorkItem).toMatchObject({
      spec: "Authoritative GitHub description",
      updated_time: "2026-08-05T03:00:00.000Z",
      user_id: "github-author",
      createdBy: {
        id: "github-author",
        name: "github-author",
        avatar: "https://example.com/github-author.png",
      },
    });
    expect(mocks.threadProps).toMatchObject({
      githubIssueTimeline: {
        items: [{ event: "assigned" }],
        loading: false,
      },
      githubIssueInteraction: mocks.githubIssueState.interaction,
      // GitHub owns labels, so they render read-only beside the editable
      // status and assignee in the Workstation trail rail.
      propertyFields: ["status", "assignee", "labels"],
      propertiesPlacement: "rail",
      propertyProps: {
        externalStatusConfig: {
          currentStatusId: "open",
          disabled: false,
        },
        labelsReadonly: true,
        showSchedule: false,
      },
    });
  });

  it("shows the GitHub detail skeleton while the issue author is loading", () => {
    const githubItem: AssignedWorkItem = {
      ...item,
      target: {
        ...item.target,
        repository: "git@github.com:org2AI/ORG2.git",
        workItemId: "132",
      },
      payload: { ...item.payload, status: "open" },
    };
    mocks.githubIssueState.timelineLoading = true;
    mocks.githubIssueState.interaction.loading = true;

    act(() => {
      root.render(createElement(AssignedWorkItemDetail, { item: githubItem }));
    });

    expect(
      container.querySelector("[data-testid='github-issue-detail-skeleton']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='work-item-content']")
    ).toBeNull();
    expect(mocks.threadWorkItem).toBeNull();
  });

  it("keeps non-GitHub Work Items on the in-app open action", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(
        createElement(AssignedWorkItemDetail, {
          item,
          onNavigate,
        })
      );
    });

    expect(mocks.detailLayoutProps?.openLabel).toBe(
      "teamInbox.actions.openWorkItem"
    );
    expect(mocks.detailLayoutProps?.headerContent).toBeUndefined();
    expect(mocks.detailLayoutProps?.headerAuxiliaryAction).toBeUndefined();
    const openIcon = mocks.detailLayoutProps?.openIcon;
    expect(React.isValidElement(openIcon)).toBe(true);
    expect((openIcon as React.ReactElement).type).toBe(SquareArrowOutUpRight);
    act(() => {
      (mocks.detailLayoutProps?.onOpen as (() => void) | undefined)?.();
    });

    expect(onNavigate).toHaveBeenCalledWith({
      kind: "open_work_item",
      projectId: "project-1",
      workItemId: "work-item-1",
    });
    expect(mocks.openExternalLink).not.toHaveBeenCalled();
  });

  it("provides editable properties to the shared thread surface", () => {
    act(() => {
      root.render(createElement(AssignedWorkItemDetail, { item }));
    });

    expect(
      container
        .querySelector("[data-testid='work-item-properties']")
        ?.getAttribute("data-property-configured")
    ).toBe("true");
  });

  it("keeps standalone Org Work Items editable and handoff-aware", () => {
    const standaloneItem: AssignedWorkItem = {
      ...item,
      target: {
        kind: "work_item",
        orgId: "cloud-org-1",
        projectId: "",
        workItemId: "work-item-1",
      },
    };
    act(() => {
      root.render(
        createElement(AssignedWorkItemDetail, { item: standaloneItem })
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='set-status']")
        ?.click();
      container
        .querySelector<HTMLButtonElement>("[data-testid='accept-handoff']")
        ?.click();
    });

    expect(mocks.updateWorkItem).toHaveBeenCalledWith({
      workItemStatus: "in_progress",
    });
    expect(mocks.transitionHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffId: "handoff-1",
        action: "accept",
      })
    );
  });

  it("passes one resolved identity to the comment composer and history surface", () => {
    act(() => {
      root.render(createElement(AssignedWorkItemDetail, { item }));
    });

    const content = container.querySelector(
      "[data-testid='work-item-content']"
    );
    expect(content?.getAttribute("data-current-user-id")).toBe("user-ea821852");
    expect(content?.getAttribute("data-current-user-name")).toBe("hanafish");
    expect(content?.getAttribute("data-current-user-avatar")).toBe(
      "https://example.com/hanafish.png"
    );
  });

  it("preserves linked-session navigation as a distinct Session tab intent", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(
        createElement(AssignedWorkItemDetail, {
          item,
          onNavigate,
        })
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='open-session']")
        ?.click();
    });

    expect(onNavigate).toHaveBeenCalledWith({
      kind: "open_session",
      sessionId: "session-1",
    });
  });
});
