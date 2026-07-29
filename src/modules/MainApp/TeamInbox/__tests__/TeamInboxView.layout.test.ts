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

import TeamInboxView from "../TeamInboxView";
import type { AssignedWorkItem } from "../domain";

const splitViewProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
const componentProps = vi.hoisted(() => ({
  assignedDetail: null as Record<string, unknown> | null,
  list: null as Record<string, unknown> | null,
  placeholder: null as Record<string, unknown> | null,
}));
const translate = vi.hoisted(() => vi.fn((key: string) => key));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: translate,
  }),
}));

vi.mock("@src/modules/shared/layouts/SplitViewLayout", () => ({
  default: (props: Record<string, unknown>) => {
    splitViewProps.current = props;
    return createElement(
      "div",
      { "data-testid": "team-inbox-split" },
      props.listContent as React.ReactNode,
      props.mainContent as React.ReactNode
    );
  },
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: (props: Record<string, unknown>) => {
    componentProps.placeholder = props;
    return null;
  },
}));

vi.mock("../components", () => ({
  AssignedWorkItemDetail: (props: Record<string, unknown>) => {
    componentProps.assignedDetail = props;
    return null;
  },
  CommentMentionDetail: () => null,
  TeamInboxList: (props: Record<string, unknown>) => {
    componentProps.list = props;
    return null;
  },
}));

describe("TeamInboxView split layout", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    splitViewProps.current = null;
    componentProps.assignedDetail = null;
    componentProps.list = null;
    componentProps.placeholder = null;
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

  it("does not leak the global Code Editor breadcrumb into Team Inbox", () => {
    act(() => {
      root.render(
        createElement(TeamInboxView, {
          dataSource: {
            listPage: () => new Promise<never>(() => undefined),
          },
        })
      );
    });

    expect(splitViewProps.current?.alwaysShowBreadcrumb).toBeUndefined();
    expect(splitViewProps.current?.hideBreadcrumbWhenSidebarCollapsed).toBe(
      true
    );
  });

  it("projects successful detail edits back into the matching Inbox row", async () => {
    const assignedItem: AssignedWorkItem = {
      id: "assigned-1",
      kind: "assigned_work_item",
      occurredAt: "2026-07-28T00:00:00.000Z",
      readAt: "2026-07-28T00:01:00.000Z",
      actor: { id: "member-1", displayName: "Yuki" },
      target: {
        kind: "work_item",
        projectId: "demo",
        workItemId: "AAA-0001",
      },
      payload: {
        title: "Old title",
        status: "todo",
        priority: "medium",
        assigneeMemberId: "member-1",
        assigneeName: "Yuki",
        summary: "Old summary",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    };

    await act(async () => {
      root.render(
        createElement(TeamInboxView, {
          dataSource: {
            listPage: async () => ({
              items: [assignedItem],
              nextCursor: null,
            }),
          },
        })
      );
      await Promise.resolve();
    });

    const onWorkItemUpdated = componentProps.assignedDetail
      ?.onWorkItemUpdated as ((workItem: WorkItem) => void) | undefined;
    expect(onWorkItemUpdated).toBeTypeOf("function");

    const updatedWorkItem: WorkItem = {
      session_id: "AAA-0001",
      user_id: "member-1",
      name: "Updated title",
      status: "in_review",
      workItemStatus: "in_review",
      priority: "high",
      spec: "## Updated summary",
      assignee: { id: "member-1", name: "Yuki" },
      star: false,
      target_date: null,
      created_time: "2026-07-28T00:00:00.000Z",
      updated_time: "2026-07-28T00:05:00.000Z",
      linkedSessions: [],
      todos: [],
    };

    act(() => onWorkItemUpdated?.(updatedWorkItem));

    const updatedItems = componentProps.list?.items as AssignedWorkItem[];
    expect(updatedItems[0].payload).toMatchObject({
      title: "Updated title",
      status: "in_review",
      priority: "high",
      assigneeMemberId: "member-1",
      assigneeName: "Yuki",
      summary: "## Updated summary",
      updatedAt: "2026-07-28T00:05:00.000Z",
    });

    act(() =>
      onWorkItemUpdated?.({
        ...updatedWorkItem,
        assignee: { id: "member-2", name: "Lin" },
      })
    );

    expect(componentProps.list?.items).toEqual([]);
  });

  it("retries the backing source instead of rereading a failed snapshot", async () => {
    const listPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const refresh = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        createElement(TeamInboxView, {
          dataSource: { listPage, refresh },
        })
      );
      await Promise.resolve();
    });

    const action = componentProps.placeholder?.action as
      | { onClick?: () => void }
      | undefined;
    expect(action?.onClick).toBeTypeOf("function");

    await act(async () => {
      action?.onClick?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(listPage).toHaveBeenCalledTimes(2);
  });
});
