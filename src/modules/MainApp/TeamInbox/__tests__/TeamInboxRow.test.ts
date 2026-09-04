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

import TeamInboxRow from "../components/TeamInboxRow";
import type { AssignedWorkItem, CommentMentionItem } from "../domain";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: { defaultValue?: string; name?: string; repository?: string }
    ) => {
      if (key === "teamInbox.handoff.rowPending") {
        return `From ${options?.name} · Awaiting response`;
      }
      if (key === "teamInbox.filters.assigned") {
        return "Assigned to me";
      }
      if (key === "teamInbox.row.issueSource") {
        return `${options?.repository} issue`;
      }
      if (key === "teamInbox.row.issueSourceFallback") {
        return "Issue";
      }
      return options?.defaultValue ?? key;
    },
  }),
}));

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type, size }: { type: string; size: number }) =>
    createElement("span", {
      "data-integration-icon": type,
      "data-icon-size": size,
    }),
}));

const assignedItem: AssignedWorkItem = {
  id: "assigned-1",
  kind: "assigned_work_item",
  occurredAt: new Date().toISOString(),
  readAt: "2026-07-28T00:00:00.000Z",
  actor: { id: "member-1", displayName: "Yuki" },
  target: {
    kind: "work_item",
    projectId: "orgii-issues-project",
    workItemId: "AAA-0001",
    repository: "https://github.com/org2AI/ORG2.git",
  },
  payload: {
    title: "验收 Team Inbox 的真实分配与已读流程",
    status: "todo",
    priority: "medium",
    assigneeMemberId: "member-1",
    assigneeName: "Yuki",
    summary:
      "## 验收目标\\n- 在 Team Inbox 的“全部”和“分配给我”中看到此事项\\n- 打开详情并标记已读",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
};

const mentionItem: CommentMentionItem = {
  id: "mention-1",
  kind: "comment_mention",
  occurredAt: new Date().toISOString(),
  readAt: "2026-07-28T00:00:00.000Z",
  actor: { id: "member-2", displayName: "Lin" },
  target: {
    kind: "session_comment",
    sessionId: "session-1",
    sessionTitle: "Review Team Inbox",
    commentId: "comment-1",
    threadId: "thread-1",
  },
  payload: {
    commentBody: "## Please review\\n- Verify the compact row",
    commentCount: 1,
  },
};

describe("TeamInboxRow", () => {
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

  it("shows assignment and the synced repository source without a Work Item preview", () => {
    act(() => {
      root.render(
        createElement(TeamInboxRow, {
          item: assignedItem,
          itemKey: "assigned_work_item:assigned-1",
          selected: true,
          onSelect: vi.fn(),
        })
      );
    });

    expect(container.querySelector("[title]")).toBeNull();
    expect(container.textContent).not.toContain("验收目标");
    expect(container.textContent).toContain("Assigned to me · ORG2 issue");
    expect(container.textContent).not.toContain("orgii-issu");
    expect(container.textContent).not.toContain(".git");
    expect(container.textContent).not.toContain("Yuki");
    expect(container.textContent).not.toContain("ago");
    const secondaryText = Array.from(container.querySelectorAll("span")).filter(
      (element) =>
        element.textContent === "Assigned to me · ORG2 issue" &&
        element.className.includes("text-text-2")
    );
    expect(secondaryText).toHaveLength(1);
    const time = Array.from(container.querySelectorAll("span")).find(
      (element) => element.textContent === "Now"
    );
    expect(time?.className).toContain("text-text-3");
    expect(time?.className).not.toContain("text-text-2");
    expect(container.querySelector('[data-icon="list-checks"]')).not.toBeNull();
    expect(container.querySelector(".bg-success-1")).toBeNull();
  });

  it("uses an issue-only source when a standalone Work Item has no repository", () => {
    act(() => {
      root.render(
        createElement(TeamInboxRow, {
          item: {
            ...assignedItem,
            target: {
              kind: "work_item",
              projectId: assignedItem.target.projectId,
              workItemId: assignedItem.target.workItemId,
            },
          },
          itemKey: "assigned_work_item:assigned-1",
          selected: false,
          onSelect: vi.fn(),
        })
      );
    });

    expect(container.textContent).toContain("Assigned to me · Issue");
    expect(container.textContent).not.toContain("orgii-issu");
  });

  it("uses the GitHub SVG for GitHub issue rows", () => {
    act(() => {
      root.render(
        createElement(TeamInboxRow, {
          item: {
            ...assignedItem,
            target: {
              ...assignedItem.target,
              workItemId: "61",
            },
            payload: {
              ...assignedItem.payload,
              status: "open",
            },
          },
          itemKey: "assigned_work_item:assigned-1",
          selected: false,
          onSelect: vi.fn(),
        })
      );
    });

    const githubIcon = container.querySelector(
      '[data-integration-icon="github"]'
    );
    expect(githubIcon).not.toBeNull();
    expect(githubIcon?.getAttribute("data-icon-size")).toBe("14");
    expect(githubIcon?.parentElement?.className).toContain("h-4");
    expect(githubIcon?.parentElement?.className).not.toContain("mt-1");
    expect(githubIcon?.parentElement?.parentElement?.className).toContain(
      "items-center"
    );
    const issueNumber = Array.from(container.querySelectorAll("span")).find(
      (element) => element.textContent === "#61"
    );
    expect(issueNumber?.className).toContain("shrink-0");
    expect(issueNumber?.className).toContain("font-semibold");
    expect(issueNumber?.className).toContain("text-text-3");
    expect(
      Array.from(container.querySelectorAll("span")).find(
        (element) => element.textContent === assignedItem.payload.title
      )?.className
    ).toContain("truncate");
    expect(container.querySelector('[data-icon="list-checks"]')).toBeNull();
  });

  it("keeps the compact comment preview for mention rows", () => {
    act(() => {
      root.render(
        createElement(TeamInboxRow, {
          item: mentionItem,
          itemKey: "comment_mention:mention-1",
          selected: false,
          onSelect: vi.fn(),
        })
      );
    });

    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="team-inbox-row"]'
    );
    const preview = container.querySelector<HTMLElement>("[title]");

    expect(row?.children).toHaveLength(2);
    expect(preview?.textContent).toBe("Please review Verify the compact row");
    expect(preview?.className).toContain("truncate");
    expect(preview?.parentElement?.textContent).toContain(
      "Please review Verify the compact row·Lin"
    );
    expect(container.textContent).toContain("Lin");
    expect(
      container.querySelector('[data-icon="message-square-more"]')
    ).not.toBeNull();
  });

  it("prioritizes pending handoff context over ordinary Work Item metadata", () => {
    act(() => {
      root.render(
        createElement(TeamInboxRow, {
          item: {
            ...assignedItem,
            payload: {
              ...assignedItem.payload,
              handoff: {
                id: "handoff-1",
                status: "pending",
                senderMemberId: "member-2",
                senderName: "Lin",
                recipientMemberId: "member-1",
                recipientName: "Yuki",
                note: "Please verify the sync path.",
                requestedAt: "2026-07-28T00:00:00.000Z",
              },
            },
          },
          itemKey: "assigned_work_item:assigned-1",
          selected: false,
          onSelect: vi.fn(),
        })
      );
    });

    expect(container.textContent).toContain(
      "From Lin · Awaiting response · ORG2 issue"
    );
    expect(container.textContent).not.toContain("Please verify the sync path.");
    expect(container.querySelector("[title]")).toBeNull();
  });
});
