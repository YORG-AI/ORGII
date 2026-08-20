// @vitest-environment jsdom
import React, { act, createElement, forwardRef } from "react";
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

import type { GitHubIssueTimelineItem } from "@src/api/tauri/github";
import type { WorkItem } from "@src/types/core/workItem";

import WorkItemContent from "..";
import type { GitHubIssueInteractionConfig } from "../types";

const mocks = vi.hoisted(() => ({
  handleDescriptionChange: vi.fn(),
  transitionWorkItemHandoff: vi.fn(),
  useGitHubIssueTimeline: vi.fn(({ enabled }: { enabled: boolean }) => ({
    timeline: enabled ? [{ event: "commented" }] : [],
    timelineLoading: false,
    timelineError: null,
  })),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    transitionWorkItemHandoff: mocks.transitionWorkItemHandoff,
    readWorkItems: () => Promise.resolve([]),
    readStandaloneWorkItems: () => Promise.resolve([]),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      typeof fallback === "string" ? fallback : key,
    i18n: { resolvedLanguage: "en" },
  }),
}));

vi.mock("@src/hooks/project", () => ({
  useWorkItemImageInsert: () => ({ handleImageInsert: vi.fn() }),
  useProjectDataChanged: () => undefined,
}));

vi.mock("@src/components/Avatar", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    createElement("span", null, children),
}));

vi.mock("@src/assets/modelIcons/org2-session.svg", () => ({
  default: (props: React.SVGProps<SVGSVGElement>) =>
    createElement("svg", props),
}));

vi.mock("@src/components/TabPill", () => ({
  default: ({
    tabs,
    activeTab,
    onChange,
  }: {
    tabs: Array<{
      key: string;
      label: string;
      badge?: React.ReactNode;
      dataTestId?: string;
    }>;
    activeTab?: string;
    onChange?: (key: string) => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "mock-tab-pill", "data-active-tab": activeTab },
      ...tabs.map((tab) =>
        createElement(
          "button",
          {
            key: tab.key,
            type: "button",
            "data-testid": tab.dataTestId,
            "data-active": String(tab.key === activeTab),
            onClick: () => onChange?.(tab.key),
          },
          tab.label,
          tab.badge
        )
      )
    ),
}));

vi.mock("@src/modules/ProjectManager/shared", () => ({
  ProjectContentEditor: forwardRef(function MockProjectContentEditor(
    {
      initialDescription,
      onDescriptionChange,
      editable,
    }: {
      initialDescription: string;
      onDescriptionChange?: (markdown: string, text: string) => void;
      editable?: boolean;
    },
    _ref
  ) {
    return createElement("textarea", {
      value: initialDescription,
      readOnly: !editable,
      "data-testid": "description-editor",
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        onDescriptionChange?.(event.target.value, event.target.value),
    });
  }),
}));

vi.mock("@src/modules/shared/components/MarkdownTextareaEditor", () => ({
  default: ({
    value,
    onChange,
    editable,
    dataTestId,
    onSubmit,
  }: {
    value: string;
    onChange?: (markdown: string) => void;
    editable?: boolean;
    dataTestId?: string;
    onSubmit?: () => void;
  }) =>
    createElement("textarea", {
      value,
      readOnly: !editable,
      "data-testid": dataTestId,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        onChange?.(event.target.value),
      onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          onSubmit?.();
        }
      },
    }),
}));

vi.mock(
  "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueTimelineItems",
  () => ({
    IssueTimelineItems: ({
      timeline,
    }: {
      timeline: Array<{ event: string }>;
    }) =>
      createElement("div", {
        "data-testid": "github-timeline-items",
        "data-count": timeline.length,
      }),
  })
);

vi.mock("../GitHubIssueComposer", () => ({
  default: ({ interaction }: { interaction: GitHubIssueInteractionConfig }) =>
    createElement("div", {
      "data-testid": "mock-github-issue-composer",
      "data-viewer": interaction.viewer?.login,
    }),
}));

vi.mock("@src/modules/shared/components/ActivityTimeline", () => ({
  ActivityHeaderActionButton: ({
    icon,
    label,
    ...buttonProps
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: React.ReactNode;
    label: string;
  }) =>
    createElement(
      "button",
      { ...buttonProps, title: label, "aria-label": label },
      icon
    ),
  MarkdownContent: ({
    body,
    clamped = true,
  }: {
    body: string;
    clamped?: boolean;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "github-read-only-description",
        "data-clamped": String(clamped),
      },
      body
    ),
  TimelineStack: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children),
  ConnectedTimelineItem: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children),
  TimelineCardHeader: () => createElement("div", null, "Header"),
  TimelineCard: ({
    children,
    footer,
    actions,
  }: React.PropsWithChildren<{
    footer?: React.ReactNode;
    actions?: React.ReactNode;
  }>) => createElement("div", null, actions, children, footer),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  DetailPanelContainer: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children),
  ScrollTrail: () => null,
  ScrollTrailTarget: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children),
  SessionTable: ({
    items,
    onSelect,
    surfaceVariant,
    bodySurface,
    headerBorder,
  }: {
    items: Array<{
      id: string;
      title: string;
      description?: string;
      agentIcon?: React.ReactNode;
      agentLabel?: React.ReactNode;
      disabled?: boolean;
      testId?: string;
    }>;
    onSelect?: (item: { id: string }) => void;
    surfaceVariant?: string;
    bodySurface?: string;
    headerBorder?: boolean;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "mock-session-table",
        "data-surface-variant": surfaceVariant,
        "data-body-surface": bodySurface,
        "data-header-border": String(headerBorder),
      },
      ...items.map((item) =>
        createElement(
          "button",
          {
            key: item.id,
            type: "button",
            disabled: item.disabled,
            "data-testid": item.testId,
            onClick: () => onSelect?.(item),
          },
          item.title,
          item.description,
          item.agentIcon,
          item.agentLabel
        )
      )
    ),
  PanelFooter: ({
    secondaryActions = [],
    primaryAction,
  }: {
    secondaryActions?: Array<{
      label: string;
      onClick?: () => void;
      dataTestId?: string;
    }>;
    primaryAction?: {
      label: string;
      onClick?: () => void;
      dataTestId?: string;
      disabled?: boolean;
    };
  }) =>
    createElement(
      "div",
      { "data-testid": "description-footer" },
      ...secondaryActions.map((action) =>
        createElement(
          "button",
          {
            key: action.label,
            type: "button",
            "data-testid": action.dataTestId,
            onClick: action.onClick,
          },
          action.label
        )
      ),
      primaryAction
        ? createElement(
            "button",
            {
              type: "button",
              "data-testid": primaryAction.dataTestId,
              onClick: primaryAction.onClick,
              disabled: primaryAction.disabled,
            },
            primaryAction.label
          )
        : null
    ),
}));

vi.mock("../../TodoChecklist", () => ({ default: () => null }));
vi.mock("../ThreadTodoChecklist", () => ({
  default: () => createElement("div", { "data-testid": "mock-thread-todos" }),
}));
vi.mock("../../WorkItemContentStack", () => ({
  default: ({
    descriptionContent,
    lowerContent,
  }: {
    descriptionContent?: React.ReactNode;
    lowerContent?: React.ReactNode;
  }) => createElement("div", null, descriptionContent, lowerContent),
}));
vi.mock("../HistoryTab", () => ({
  default: ({
    canComment,
    threadNavigation,
  }: {
    canComment?: boolean;
    threadNavigation?: React.ReactNode;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "mock-activity",
        "data-can-comment": String(canComment),
      },
      threadNavigation
    ),
}));
vi.mock("../OutputTab", () => ({
  default: () => createElement("div", { "data-testid": "mock-output" }),
}));

vi.mock("../hooks/useWorkItemContentState", () => ({
  useWorkItemContentState: ({ workItem }: { workItem: WorkItem }) => ({
    currentUser: { id: "user-1", name: "Ada" },
    currentUserMemberIds: new Set(["user-1", "member-alias"]),
    activeSessionTab: "session",
    setActiveSessionTab: vi.fn(),
    commentText: "",
    setCommentText: vi.fn(),
    isSubscribed: true,
    setIsSubscribed: vi.fn(),
    isSubmittingComment: false,
    sessionTabItems: [],
    resolvedDescription: workItem.spec,
    rawDescription: workItem.spec,
    timelineEntries: [
      {
        id: "event-1",
        timestamp: "2026-07-28T10:00:00.000Z",
        type: "updated",
        userName: "Ada",
        descriptions: ["updated status"],
      },
    ],
    handleTitleChange: vi.fn(),
    handleDescriptionChange: mocks.handleDescriptionChange,
    handleTodosChange: vi.fn(),
    handleCommentSubmit: vi.fn(),
    handleStartAgentAndOpenChat: vi.fn(),
  }),
}));

vi.mock("../hooks/useGitHubIssueTimeline", () => ({
  useGitHubIssueTimeline: mocks.useGitHubIssueTimeline,
}));

const baseWorkItem: WorkItem = {
  session_id: "work-item-1",
  user_id: "user-1",
  name: "Markdown editor",
  status: "backlog",
  spec: "# Existing description",
  star: false,
  target_date: null,
  created_time: "2026-07-21T12:00:00Z",
  updated_time: "2026-07-21T12:00:00Z",
  linkedSessions: [],
  todos: [],
};

function createGitHubIssueInteraction(
  overrides: Partial<GitHubIssueInteractionConfig> = {}
): GitHubIssueInteractionConfig {
  return {
    viewer: {
      login: "github-viewer",
      avatar_url: "https://example.com/github-viewer.png",
    },
    issueState: "open",
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
    onAddComment: vi.fn(async () => undefined),
    onUpdateBody: vi.fn(async () => undefined),
    onLoadDuplicateCandidates: vi.fn(async () => undefined),
    onStatusChange: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("WorkItemContent description editing", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.handleDescriptionChange.mockReset();
    mocks.transitionWorkItemHandoff.mockReset();
    mocks.useGitHubIssueTimeline.mockClear();
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

  function changeDescription(value: string, testId = "description-editor") {
    const editor = container.querySelector<HTMLTextAreaElement>(
      `[data-testid='${testId}']`
    );
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(editor, value);
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("shows a creation-session row and opens it without treating it as an execution run", () => {
    const onOpenSession = vi.fn();
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: {
            ...baseWorkItem,
            originSession: {
              session_id: "sdeagent-origin-1",
              provider: "org2",
              actor_id: "agent:sde",
              session_type: "native",
              captured_at: "2026-08-12T23:54:19.640Z",
            },
          },
          onOpenSession,
        })
      );
    });

    const originRow = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-origin-session-sdeagent-origin-1']"
    );
    expect(originRow).not.toBeNull();
    expect(originRow?.textContent).toContain("sdeagent-origin-1");
    expect(
      container.querySelector("[data-testid='work-item-usage-summary']")
    ).toBeNull();

    act(() => originRow?.click());
    expect(onOpenSession).toHaveBeenCalledWith("sdeagent-origin-1");
  });

  it("uses the bordered session surface and stable English ORG2 agent presentation", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: {
            ...baseWorkItem,
            linkedSessions: [
              {
                session_id: "native-session-1",
                session_type: "native",
                agent_role: "coding",
                started_at: "2026-08-20T12:00:00.000Z",
                completed_at: "2026-08-20T12:01:00.000Z",
                status: "completed",
                cost_usd: 0,
                total_tokens: 0,
              },
            ],
          },
        })
      );
    });

    const table = container.querySelector("[data-testid='mock-session-table']");
    const row = container.querySelector(
      "[data-testid='work-item-linked-session-native-session-1']"
    );

    expect(table?.getAttribute("data-surface-variant")).toBe("default");
    expect(table?.getAttribute("data-body-surface")).toBe("pane");
    expect(table?.getAttribute("data-header-border")).toBe("false");
    expect(row?.textContent).toContain("Coding");
    expect(row?.textContent).not.toContain("workItems.agentWorkflow");
    expect(row?.querySelector("[data-agent-provider='org2']")).not.toBeNull();
  });

  it("is editable by default and only shows Cancel/Save after a change", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: baseWorkItem,
          onUpdateWorkItem: vi.fn(),
        })
      );
    });

    const editor = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='description-editor']"
    );
    expect(editor?.readOnly).toBe(false);
    expect(
      container.querySelector("[data-testid='description-footer']")
    ).toBeNull();

    changeDescription("## Updated description");

    expect(
      container.querySelector("[data-testid='description-footer']")
    ).not.toBeNull();

    changeDescription(baseWorkItem.spec);
    expect(
      container.querySelector("[data-testid='description-footer']")
    ).toBeNull();

    changeDescription("## Updated description");

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-cancel']"
        )
        ?.click();
    });

    expect(editor?.value).toBe(baseWorkItem.spec);
    expect(
      container.querySelector("[data-testid='description-footer']")
    ).toBeNull();

    changeDescription("### Saved description");
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-save']"
        )
        ?.click();
    });

    expect(mocks.handleDescriptionChange).toHaveBeenCalledWith(
      "### Saved description"
    );
    expect(
      container.querySelector("[data-testid='description-footer']")
    ).toBeNull();
  });

  it("keeps GitHub-backed work-item descriptions read-only", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: { ...baseWorkItem, status: "open", workItemStatus: "open" },
          onUpdateWorkItem: vi.fn(),
        })
      );
    });

    expect(
      container.querySelector("[data-testid='description-editor']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='github-read-only-description']")
        ?.textContent
    ).toBe(baseWorkItem.spec);
    expect(
      container
        .querySelector("[data-testid='github-read-only-description']")
        ?.getAttribute("data-clamped")
    ).toBe("true");
    expect(
      container
        .querySelector("[data-testid='github-timeline-items']")
        ?.getAttribute("data-count")
    ).toBe("1");
    expect(
      container.querySelector("[data-testid='description-footer']")
    ).toBeNull();
  });

  it("hides the GitHub issue body edit action without permission", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: { ...baseWorkItem, status: "open", workItemStatus: "open" },
          presentation: "thread",
          githubIssueTimeline: { items: [], loading: false },
          githubIssueInteraction: createGitHubIssueInteraction({
            canEditBody: false,
            canManageStatus: false,
          }),
        })
      );
    });

    expect(
      container.querySelector("[data-testid='work-item-description-edit']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='github-read-only-description']")
        ?.textContent
    ).toBe(baseWorkItem.spec);
  });

  it("edits a GitHub issue body with the shared Markdown editor when permitted", async () => {
    const onUpdateBody = vi.fn(async () => undefined);
    const githubIssueInteraction = createGitHubIssueInteraction({
      onUpdateBody,
    });

    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: { ...baseWorkItem, status: "open", workItemStatus: "open" },
          presentation: "thread",
          githubIssueTimeline: { items: [], loading: false },
          githubIssueInteraction,
        })
      );
    });

    const editButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-description-edit']"
    );
    expect(editButton?.textContent).toBe("");
    expect(editButton?.getAttribute("aria-label")).toBe("common:actions.edit");
    expect(editButton?.title).toBe("common:actions.edit");
    act(() => editButton?.click());

    const editor = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='github-issue-description-editor']"
    );
    expect(editor?.value).toBe(baseWorkItem.spec);

    changeDescription(
      "## Updated GitHub description",
      "github-issue-description-editor"
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-save']"
        )
        ?.click();
      await Promise.resolve();
    });

    expect(onUpdateBody).toHaveBeenCalledWith("## Updated GitHub description");
    expect(
      container.querySelector("[data-testid='github-issue-description-editor']")
    ).toBeNull();
  });

  it("saves a previously empty GitHub issue body from the editor shortcut", async () => {
    const onUpdateBody = vi.fn(async () => undefined);
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: {
            ...baseWorkItem,
            spec: "",
            status: "open",
            workItemStatus: "open",
          },
          presentation: "thread",
          githubIssueTimeline: { items: [], loading: false },
          githubIssueInteraction: createGitHubIssueInteraction({
            onUpdateBody,
          }),
        })
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-edit']"
        )
        ?.click();
    });
    changeDescription(
      "First GitHub description",
      "github-issue-description-editor"
    );

    await act(async () => {
      container
        .querySelector<HTMLTextAreaElement>(
          "[data-testid='github-issue-description-editor']"
        )
        ?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            metaKey: true,
            bubbles: true,
          })
        );
      await Promise.resolve();
    });

    expect(onUpdateBody).toHaveBeenCalledWith("First GitHub description");
  });

  it("allows an authorized user to clear the GitHub issue body", async () => {
    const onUpdateBody = vi.fn(async () => undefined);
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: { ...baseWorkItem, status: "open", workItemStatus: "open" },
          presentation: "thread",
          githubIssueTimeline: { items: [], loading: false },
          githubIssueInteraction: createGitHubIssueInteraction({
            onUpdateBody,
          }),
        })
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-edit']"
        )
        ?.click();
    });
    changeDescription("", "github-issue-description-editor");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-save']"
        )
        ?.click();
      await Promise.resolve();
    });

    expect(onUpdateBody).toHaveBeenCalledWith("");
  });

  it("keeps a GitHub issue body draft visible when the update fails", async () => {
    const githubIssueInteraction = createGitHubIssueInteraction({
      onUpdateBody: vi.fn(async () => {
        throw new Error("update failed");
      }),
    });

    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: { ...baseWorkItem, status: "open", workItemStatus: "open" },
          presentation: "thread",
          githubIssueTimeline: { items: [], loading: false },
          githubIssueInteraction,
        })
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-edit']"
        )
        ?.click();
    });
    changeDescription(
      "Unsaved GitHub description",
      "github-issue-description-editor"
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-save']"
        )
        ?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLTextAreaElement>(
        "[data-testid='github-issue-description-editor']"
      )?.value
    ).toBe("Unsaved GitHub description");
    expect(container.textContent).toContain(
      "common:git.issues.composer.bodyUpdateFailed"
    );
  });

  it("reuses a provided GitHub timeline without enabling another load", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: { ...baseWorkItem, status: "open", workItemStatus: "open" },
          githubIssueTimeline: {
            items: [
              { event: "commented" },
              { event: "assigned" },
            ] as GitHubIssueTimelineItem[],
            loading: false,
          },
        })
      );
    });

    expect(mocks.useGitHubIssueTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(
      container
        .querySelector("[data-testid='github-timeline-items']")
        ?.getAttribute("data-count")
    ).toBe("2");
  });

  it("accepts a pending handoff addressed to another current-user member alias", async () => {
    const acceptedHandoff = {
      id: "handoff-1",
      status: "accepted" as const,
      senderMemberId: "member-sender",
      senderName: "Lin",
      recipientMemberId: "member-alias",
      recipientName: "Ada Team",
      requestedAt: "2026-07-28T10:00:00.000Z",
      respondedAt: "2026-07-28T11:00:00.000Z",
    };
    mocks.transitionWorkItemHandoff.mockResolvedValue({
      frontmatter: { handoff: acceptedHandoff },
    });
    const onRefreshWorkflow = vi.fn();
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: {
            ...baseWorkItem,
            handoff: { ...acceptedHandoff, status: "pending" },
          },
          projectSlug: "demo",
          shortId: "DEM-0001",
          onRefreshWorkflow,
        })
      );
    });

    const accept = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "teamInbox.handoff.accept"
    );
    expect(accept).toBeDefined();
    await act(async () => {
      accept?.click();
      await Promise.resolve();
    });

    expect(mocks.transitionWorkItemHandoff).toHaveBeenCalledWith(
      "demo",
      "DEM-0001",
      {
        handoffId: "handoff-1",
        action: "accept",
        actor: { id: "member-alias", name: "Ada Team" },
        note: undefined,
      }
    );
    expect(onRefreshWorkflow).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("teamInbox.handoff.acceptedTitle");
  });

  it("keeps the thread compact until Edit is explicitly requested", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: baseWorkItem,
          presentation: "thread",
          onUpdateWorkItem: vi.fn(),
        })
      );
    });

    expect(
      container.querySelector("[data-testid='description-editor']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='github-read-only-description']")
        ?.textContent
    ).toBe(baseWorkItem.spec);
    expect(
      container
        .querySelector("[data-testid='github-read-only-description']")
        ?.getAttribute("data-clamped")
    ).toBe("true");

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-edit']"
        )
        ?.click();
    });

    expect(
      container.querySelector("[data-testid='description-editor']")
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        "[data-testid='work-item-description-save']"
      )?.disabled
    ).toBe(true);

    changeDescription("## Compact thread editor");

    expect(
      container.querySelector<HTMLButtonElement>(
        "[data-testid='work-item-description-save']"
      )?.disabled
    ).toBe(false);

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-save']"
        )
        ?.click();
    });

    expect(mocks.handleDescriptionChange).toHaveBeenCalledWith(
      "## Compact thread editor"
    );
    expect(
      container.querySelector("[data-testid='description-editor']")
    ).toBeNull();
  });

  it("drills into Discussion and returns without mixing view content", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: baseWorkItem,
          presentation: "thread",
          onUpdateWorkItem: vi.fn(),
        })
      );
    });

    const discussionAction = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-thread-open-discussion']"
    );

    expect(discussionAction).not.toBeNull();
    expect(
      discussionAction?.closest(
        "[data-testid='work-item-thread-secondary-navigation']"
      )
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='work-item-thread-back-overview']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='github-read-only-description']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='mock-thread-todos']")
    ).not.toBeNull();
    expect(container.querySelector("[data-testid='mock-activity']")).toBeNull();

    act(() => discussionAction?.click());

    const backAction = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-thread-back-overview']"
    );
    expect(backAction).not.toBeNull();
    expect(
      container.querySelector(
        "[data-testid='work-item-thread-open-discussion']"
      )
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='mock-activity']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='github-read-only-description']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='mock-thread-todos']")
    ).toBeNull();

    act(() => backAction?.click());

    expect(
      container.querySelector("[data-testid='github-read-only-description']")
    ).not.toBeNull();
    expect(container.querySelector("[data-testid='mock-activity']")).toBeNull();
  });

  it("keeps GitHub comments and status actions inline without Discussion navigation", () => {
    const githubIssueInteraction = createGitHubIssueInteraction();

    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: {
            ...baseWorkItem,
            status: "open",
            workItemStatus: "open",
          },
          presentation: "thread",
          githubIssueTimeline: { items: [], loading: false },
          githubIssueInteraction,
        })
      );
    });

    expect(
      container
        .querySelector("[data-testid='mock-github-issue-composer']")
        ?.getAttribute("data-viewer")
    ).toBe("github-viewer");
    expect(
      container.querySelector(
        "[data-testid='work-item-thread-secondary-navigation']"
      )
    ).toBeNull();
    expect(
      container.querySelector(
        "[data-testid='work-item-thread-open-discussion']"
      )
    ).toBeNull();
  });

  it("does not restore dead local Discussion navigation while GitHub state hydrates", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: {
            ...baseWorkItem,
            status: "open",
            workItemStatus: "open",
          },
          presentation: "thread",
        })
      );
    });

    expect(
      container.querySelector(
        "[data-testid='work-item-thread-secondary-navigation']"
      )
    ).toBeNull();
    expect(
      container.querySelector(
        "[data-testid='work-item-thread-open-discussion']"
      )
    ).toBeNull();
  });

  it("keeps the current secondary view on refresh and resets on item switch", () => {
    const renderThread = (workItem: WorkItem) =>
      root.render(
        createElement(WorkItemContent, {
          workItem,
          presentation: "thread",
          onUpdateWorkItem: vi.fn(),
        })
      );

    act(() => renderThread(baseWorkItem));
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-thread-open-discussion']"
        )
        ?.click();
    });

    act(() =>
      renderThread({
        ...baseWorkItem,
        updated_time: "2026-07-28T11:00:00.000Z",
      })
    );
    expect(
      container.querySelector("[data-testid='work-item-thread-back-overview']")
    ).not.toBeNull();

    act(() =>
      renderThread({
        ...baseWorkItem,
        session_id: "work-item-2",
        name: "Second item",
      })
    );
    expect(
      container.querySelector(
        "[data-testid='work-item-thread-open-discussion']"
      )
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='work-item-thread-back-overview']")
    ).toBeNull();
    expect(container.querySelector("[data-testid='mock-activity']")).toBeNull();
  });

  it("keeps read-only Discussion visible without enabling comment mutation", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: baseWorkItem,
          presentation: "thread",
        })
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-thread-open-discussion']"
        )
        ?.click();
    });

    expect(
      container
        .querySelector("[data-testid='mock-activity']")
        ?.getAttribute("data-can-comment")
    ).toBe("false");
  });

  it("renders legacy escaped Markdown as real Markdown without rewriting it on view", () => {
    const onUpdateWorkItem = vi.fn();
    const legacyMarkdown =
      "## 验收目标\\n- 打开 Team Inbox\\n- 验证 Sidebar 未读数";

    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: { ...baseWorkItem, spec: legacyMarkdown },
          presentation: "thread",
          onUpdateWorkItem,
        })
      );
    });

    const rendered = container.querySelector(
      "[data-testid='github-read-only-description']"
    );
    expect(rendered?.textContent).toBe(
      "## 验收目标\n- 打开 Team Inbox\n- 验证 Sidebar 未读数"
    );
    expect(rendered?.textContent).not.toContain("\\n");
    expect(onUpdateWorkItem).not.toHaveBeenCalled();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-description-edit']"
        )
        ?.click();
    });

    expect(
      container.querySelector<HTMLTextAreaElement>(
        "[data-testid='description-editor']"
      )?.value
    ).toBe("## 验收目标\n- 打开 Team Inbox\n- 验证 Sidebar 未读数");
  });

  it("preserves a single inline escaped newline in technical prose", () => {
    act(() => {
      root.render(
        createElement(WorkItemContent, {
          workItem: {
            ...baseWorkItem,
            spec: "Use `\\n` as the delimiter.",
          },
          presentation: "thread",
          onUpdateWorkItem: vi.fn(),
        })
      );
    });

    expect(
      container.querySelector("[data-testid='github-read-only-description']")
        ?.textContent
    ).toBe("Use `\\n` as the delimiter.");
  });
});
