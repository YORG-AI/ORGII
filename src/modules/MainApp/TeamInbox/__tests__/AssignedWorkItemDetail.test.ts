// @vitest-environment jsdom
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
    updateWorkItem: vi.fn(),
    refreshWorkItem: vi.fn(),
  }),
}));

vi.mock("@src/modules/ProjectManager/WorkItems/components", () => ({
  WorkItemThreadSurface: ({
    onStartAgent,
    onOpenSession,
    propertyProps,
    currentUser,
  }: {
    onStartAgent?: () => void;
    onOpenSession?: (sessionId: string) => void;
    propertyProps?: Record<string, unknown>;
    currentUser?: { id: string; name: string; avatar?: string };
  }) =>
    createElement(
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
          "data-testid": "start-agent",
          onClick: onStartAgent,
        },
        "Start Agent"
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": "open-session",
          onClick: () => onOpenSession?.("session-1"),
        },
        "Open session"
      )
    ),
}));

vi.mock("../components/TeamInboxDetailLayout", () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children),
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

  it("requests canonical Work Item start instead of mounting an Inbox orchestrator", () => {
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
        .querySelector<HTMLButtonElement>("[data-testid='start-agent']")
        ?.click();
    });

    expect(onNavigate).toHaveBeenCalledWith({
      kind: "open_work_item",
      projectId: "project-1",
      workItemId: "work-item-1",
      action: "start_agent",
    });
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
