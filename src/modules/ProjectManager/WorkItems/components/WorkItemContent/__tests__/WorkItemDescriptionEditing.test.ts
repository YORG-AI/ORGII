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

import type { WorkItem } from "@src/types/core/workItem";

import WorkItemContent from "..";

const mocks = vi.hoisted(() => ({
  handleDescriptionChange: vi.fn(),
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
}));

vi.mock("@src/components/Avatar", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    createElement("span", null, children),
}));

vi.mock("@src/components/TabPill", () => ({
  default: () => null,
}));

vi.mock("@src/modules/ProjectManager/shared", () => ({
  ProjectContentEditor: forwardRef(function MockProjectContentEditor(
    {
      initialDescription,
      onDescriptionChange,
      editable,
      descriptionDefaultMode,
    }: {
      initialDescription: string;
      onDescriptionChange?: (markdown: string, text: string) => void;
      editable?: boolean;
      descriptionDefaultMode?: string;
    },
    _ref
  ) {
    return createElement("textarea", {
      value: initialDescription,
      readOnly: !editable,
      "data-testid": "description-editor",
      "data-default-mode": descriptionDefaultMode ?? "",
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        onDescriptionChange?.(event.target.value, event.target.value),
    });
  }),
}));

vi.mock(
  "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel",
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

vi.mock("@src/modules/shared/components/ActivityTimeline", () => ({
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
  SessionTable: () => null,
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

vi.mock("../../AgentWorkflow", () => ({ default: () => null }));
vi.mock("../../TodoChecklist", () => ({ default: () => null }));
vi.mock("../ThreadTodoChecklist", () => ({ default: () => null }));
vi.mock("../../WorkItemContentStack", () => ({
  default: ({ descriptionContent }: { descriptionContent?: React.ReactNode }) =>
    createElement("div", null, descriptionContent),
}));
vi.mock("../HistoryTab", () => ({ default: () => null }));
vi.mock("../OutputTab", () => ({ default: () => null }));

vi.mock("../hooks/useWorkItemContentState", () => ({
  useWorkItemContentState: ({ workItem }: { workItem: WorkItem }) => ({
    currentUser: { id: "user-1", name: "Ada" },
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
    timelineEntries: [],
    handleTitleChange: vi.fn(),
    handleDescriptionChange: mocks.handleDescriptionChange,
    handleTodosChange: vi.fn(),
    handleCommentSubmit: vi.fn(),
    handleStartAgentAndOpenChat: vi.fn(),
  }),
}));

vi.mock("../hooks/useGitHubIssueTimeline", () => ({
  useGitHubIssueTimeline: ({ enabled }: { enabled: boolean }) => ({
    timeline: enabled ? [{ event: "commented" }] : [],
    timelineLoading: false,
    timelineError: null,
  }),
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

  function changeDescription(value: string) {
    const editor = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='description-editor']"
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
    expect(editor?.getAttribute("data-default-mode")).toBe("");
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
});
