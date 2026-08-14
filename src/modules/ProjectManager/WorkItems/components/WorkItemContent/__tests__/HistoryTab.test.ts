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

import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";

import HistoryTab from "../HistoryTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: "en" },
    t: (key: string, options?: string | Record<string, unknown>) => {
      if (key === "workItems.activity.groupedChanges") {
        return `made ${String(
          typeof options === "object" ? options.count : ""
        )} changes`;
      }
      if (key === "workItems.activity.groupedTodoChanges") {
        return `updated to-dos · ${String(
          typeof options === "object" ? options.count : ""
        )} actions`;
      }
      if (key === "workItems.activity.activityHistory") {
        return "Activity history";
      }
      if (key === "workItems.activity.activityHistoryCount") {
        return `${String(
          typeof options === "object" ? options.count : ""
        )} events`;
      }
      return typeof options === "string" ? options : key;
    },
  }),
}));

vi.mock("@src/modules/shared/components/MarkdownTextareaEditor", () => ({
  default: ({
    appearance,
    dataTestId,
    minHeight,
  }: {
    appearance?: string;
    dataTestId?: string;
    minHeight?: number;
  }) =>
    createElement("textarea", {
      "data-testid": dataTestId,
      "data-appearance": appearance,
      "data-min-height": minHeight,
    }),
}));

vi.mock("@src/modules/shared/components/MarkdownContent", () => ({
  MarkdownContent: ({ body }: { body: string }) =>
    createElement("div", null, body),
}));

const baseProps = {
  timelineEntries: [
    {
      id: "event-1",
      timestamp: "2026-07-27T18:23:00.000Z",
      type: WORK_ITEM_HISTORY_ACTION.COMMENTED,
      userName: "Yuki",
      userAvatar: "https://example.com/yuki.png",
      userColor: "#52c41a",
      descriptions: ["updated to-dos"],
    },
  ],
  currentUser: {
    id: "user-1",
    name: "Yuki",
    email: "yuki@example.com",
    avatar: "https://example.com/yuki.png",
    color: "#52c41a",
  },
  isSubscribed: false,
  onToggleSubscribe: vi.fn(),
  commentText: "",
  onCommentTextChange: vi.fn(),
  onCommentSubmit: vi.fn(),
  isSubmittingComment: false,
};

describe("HistoryTab discussion and activity presentation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}

        unobserve() {}

        disconnect() {}
      }
    );
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
    vi.unstubAllGlobals();
  });

  const renderHistory = (presentation: "default" | "thread" = "default") => {
    act(() => {
      root.render(createElement(HistoryTab, { ...baseProps, presentation }));
    });
  };

  it("renders human comments as the primary thread discussion", () => {
    act(() => {
      root.render(
        createElement(HistoryTab, {
          ...baseProps,
          presentation: "thread",
          threadNavigation: createElement(
            "button",
            { "data-testid": "thread-back" },
            "Back"
          ),
        })
      );
    });

    expect(container.textContent).toContain("updated to-dos");
    expect(
      container.querySelector("[data-testid='work-item-thread-discussion']")
    ).not.toBeNull();
    expect(
      container.querySelector(
        "[data-testid='work-item-thread-activity-history']"
      )
    ).toBeNull();
    const backAction = container.querySelector("[data-testid='thread-back']");
    const subscriptionAction = container.querySelector(
      "[data-testid='work-item-subscription-toggle']"
    );
    expect(backAction).not.toBeNull();
    expect(backAction?.parentElement).toBe(subscriptionAction?.parentElement);
    expect(subscriptionAction).not.toBeNull();
    expect(
      container
        .querySelector("[data-testid='work-item-comment-editor']")
        ?.getAttribute("data-appearance")
    ).toBe("plain");
    const commentDock = container.querySelector(
      "[data-testid='work-item-thread-comment-dock']"
    );
    expect(commentDock?.className).toContain("pb-3");
    expect(commentDock?.className).toContain("bg-transparent");
    expect(commentDock?.className).not.toContain("bg-bg-1");
    expect(commentDock?.className).not.toContain("border-t");
    expect(
      container.querySelectorAll("img[src='https://example.com/yuki.png']")
    ).toHaveLength(2);
  });

  it("keeps an empty read-only discussion useful without a dead composer", () => {
    act(() => {
      root.render(
        createElement(HistoryTab, {
          ...baseProps,
          timelineEntries: [],
          presentation: "thread",
          canComment: false,
        })
      );
    });

    expect(
      container.querySelector(
        "[data-testid='work-item-thread-discussion-empty']"
      )?.textContent
    ).toContain("workItems.activity.noComments");
    expect(
      container.querySelector("[data-testid='work-item-comment-composer']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='work-item-subscription-toggle']")
    ).not.toBeNull();
  });

  it("renders persisted reply threads with resolve, reopen, and reply actions", () => {
    const onReplyToComment = vi.fn();
    const onResolveThread = vi.fn();
    const onReopenThread = vi.fn();
    act(() => {
      root.render(
        createElement(HistoryTab, {
          ...baseProps,
          timelineEntries: [],
          presentation: "thread",
          comments: [
            {
              id: "comment-root",
              author: "user-1",
              content: "Please show the proof.",
              created_at: "2026-08-08T10:00:00.000Z",
              thread_id: "comment-root",
            },
            {
              id: "comment-reply",
              author: "user-1",
              content: "Proof attached.",
              created_at: "2026-08-08T10:01:00.000Z",
              parent_id: "comment-root",
              thread_id: "comment-root",
            },
          ],
          replyToCommentId: "comment-root",
          onReplyToComment,
          onResolveThread,
          onReopenThread,
        })
      );
    });

    expect(
      container.querySelector(
        "[data-testid='work-item-discussion-thread-comment-root']"
      )?.textContent
    ).toContain("Proof attached.");
    expect(
      container.querySelector(
        "[data-testid='work-item-discussion-reply-context']"
      )
    ).not.toBeNull();

    act(() => {
      (
        container.querySelector(
          "[data-testid='work-item-discussion-reply-comment-reply']"
        ) as HTMLButtonElement
      ).click();
      (
        container.querySelector(
          "[data-testid='work-item-discussion-resolve-comment-root']"
        ) as HTMLButtonElement
      ).click();
    });
    expect(onReplyToComment).toHaveBeenCalledWith("comment-reply");
    expect(onResolveThread).toHaveBeenCalledWith(
      "comment-root",
      "comment-reply"
    );
    expect(onReopenThread).not.toHaveBeenCalled();
  });

  it("keeps the full editor treatment in the default presentation", () => {
    renderHistory();

    const editor = container.querySelector(
      "[data-testid='work-item-comment-editor']"
    );

    expect(
      container.querySelector("[data-testid='work-item-thread-discussion']")
    ).toBeNull();
    expect(container.textContent).toContain("updated to-dos");
    expect(
      container.querySelector("[data-testid='work-item-comment-composer']")
    ).toBeNull();
    expect(editor?.getAttribute("data-appearance")).toBe("outlined");
    expect(editor?.getAttribute("data-min-height")).toBe("60");
    expect(
      container.querySelector("[data-testid='work-item-default-comment-dock']")
        ?.className
    ).toContain("pb-3");
  });

  it("keeps machine events in a collapsed activity-history disclosure", () => {
    act(() => {
      root.render(
        createElement(HistoryTab, {
          ...baseProps,
          presentation: "thread",
          timelineEntries: [
            {
              id: "update-1",
              timestamp: "2026-07-28T11:14:00.000Z",
              type: WORK_ITEM_HISTORY_ACTION.UPDATED,
              actorId: "user-1",
              userName: "Yuki",
              descriptions: ["changed status"],
              changeFields: ["status"],
              changeFieldKeys: ["status"],
            },
            baseProps.timelineEntries[0],
            {
              id: "update-2",
              timestamp: "2026-07-28T11:15:00.000Z",
              type: WORK_ITEM_HISTORY_ACTION.UPDATED,
              actorId: "user-1",
              userName: "Yuki",
              descriptions: ["changed priority"],
              changeFields: ["priority"],
              changeFieldKeys: ["priority"],
            },
          ],
        })
      );
    });

    const activityHistory = container.querySelector<HTMLDetailsElement>(
      "[data-testid='work-item-thread-activity-history']"
    );
    const commentCard = Array.from(
      container.querySelectorAll(
        "[data-testid='work-item-thread-discussion'] *"
      )
    ).find((element) => element.textContent?.includes("updated to-dos"));

    expect(activityHistory?.open).toBe(false);
    expect(activityHistory?.querySelector("summary")?.textContent).toContain(
      "Activity history"
    );
    expect(activityHistory?.querySelector("summary")?.textContent).toContain(
      "2 events"
    );
    expect(commentCard?.closest("details")).toBeNull();

    act(() => activityHistory?.querySelector("summary")?.click());
    expect(activityHistory?.open).toBe(true);
  });

  it("condenses adjacent changes while keeping the raw audit trail expandable", () => {
    act(() => {
      root.render(
        createElement(HistoryTab, {
          ...baseProps,
          timelineEntries: [
            {
              id: "update-1",
              timestamp: "2026-07-28T11:14:00.000Z",
              type: WORK_ITEM_HISTORY_ACTION.UPDATED,
              actorId: "user-1",
              userName: "Yuki",
              descriptions: ["changed status from In Review to Backlog"],
              changeFields: ["status"],
              changeFieldKeys: ["status"],
            },
            {
              id: "update-2",
              timestamp: "2026-07-28T11:15:00.000Z",
              type: WORK_ITEM_HISTORY_ACTION.UPDATED,
              actorId: "user-1",
              userName: "Yuki",
              descriptions: ["changed priority from High to Urgent"],
              changeFields: ["priority"],
              changeFieldKeys: ["priority"],
            },
            baseProps.timelineEntries[0],
          ],
        })
      );
    });

    const group = container.querySelector<HTMLDetailsElement>(
      "[data-testid='work-item-activity-change-group']"
    );
    const summary = group?.querySelector("summary");

    expect(group?.open).toBe(false);
    expect(summary?.textContent).toContain("Yuki made 2 changes");
    expect(summary?.textContent).toContain("status");
    expect(summary?.textContent).toContain("priority");
    expect(summary?.textContent).not.toContain("2026");
    expect(container.textContent).toContain("updated to-dos");

    act(() => summary?.click());

    expect(group?.open).toBe(true);
    expect(
      group?.querySelector(
        "[data-testid='work-item-activity-change-group-details']"
      )?.textContent
    ).toContain("changed priority from High to Urgent");
  });

  it("labels a to-do-only burst without an ambiguous field chip", () => {
    act(() => {
      root.render(
        createElement(HistoryTab, {
          ...baseProps,
          timelineEntries: [
            {
              id: "todo-1",
              timestamp: "2026-07-28T12:54:00.000Z",
              type: WORK_ITEM_HISTORY_ACTION.UPDATED,
              actorId: "user-1",
              userName: "Yuki",
              descriptions: ["completed “Ship it”"],
              changeFields: ["to-dos"],
              changeFieldKeys: ["todos"],
            },
            {
              id: "todo-2",
              timestamp: "2026-07-28T12:55:00.000Z",
              type: WORK_ITEM_HISTORY_ACTION.UPDATED,
              actorId: "user-1",
              userName: "Yuki",
              descriptions: ["added “Verify it”"],
              changeFields: ["to-dos"],
              changeFieldKeys: ["todos"],
            },
          ],
        })
      );
    });

    const group = container.querySelector<HTMLDetailsElement>(
      "[data-testid='work-item-activity-change-group']"
    );
    const summary = group?.querySelector("summary");

    expect(summary?.textContent).toContain("Yuki updated to-dos · 2 actions");
    expect(summary?.querySelector("[aria-label='to-dos']")).toBeNull();

    act(() => summary?.click());

    expect(
      group?.querySelector(
        "[data-testid='work-item-activity-change-group-details']"
      )?.textContent
    ).toContain("completed “Ship it”");
  });
});
