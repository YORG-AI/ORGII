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

import CommentMentionDetail from "../components/CommentMentionDetail";
import type { CommentMentionItem } from "../domain";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      if (key === "teamInbox.detail.mentionedYou") return "mentioned you";
      if (key === "teamInbox.detail.threadComments") {
        return `${options?.count ?? 0} comments in this thread`;
      }
      if (key === "teamInbox.status.unread") return "Unread";
      if (key === "common:actions.openInNewTab") return "Open in New Tab";
      return key;
    },
    i18n: { resolvedLanguage: "en" },
  }),
}));

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

const mention: CommentMentionItem = {
  id: "mention-1",
  kind: "comment_mention",
  occurredAt: "2026-09-02T06:00:00.000Z",
  readAt: null,
  actor: {
    id: "member-1",
    displayName: "Vince",
    avatarUrl: "https://example.com/vince.png",
  },
  target: {
    kind: "session_comment",
    sessionId: "session-1",
    sessionTitle: "Product planning",
    commentId: "comment-1",
    threadId: "thread-1",
    anchor: "turn-3",
  },
  payload: {
    commentBody: "@Harry Who are you?",
    context: "Context from the surrounding thread",
    commentCount: 2,
  },
};

describe("CommentMentionDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("uses the shared repository-style activity surface", () => {
    act(() => {
      root.render(createElement(CommentMentionDetail, { item: mention }));
    });

    const thread = container.querySelector<HTMLElement>(
      '[data-testid="team-inbox-mention-thread"]'
    );
    const contentColumn = thread?.firstElementChild;
    const card = Array.from(
      container.querySelectorAll<HTMLElement>("div")
    ).find(
      (element) =>
        element.className.includes("rounded-xl") &&
        element.className.includes("border-border-1")
    );

    expect(thread).not.toBeNull();
    expect(contentColumn?.className).toContain("max-w-[920px]");
    expect(card?.firstElementChild?.className).toContain(
      "bg-primary-container"
    );
    expect(container.textContent).toContain("Vince mentioned you");
    expect(container.textContent).toContain("2 comments in this thread");
    expect(container.textContent).toContain(
      "Context from the surrounding thread"
    );
    expect(container.textContent).toContain("@Harry Who are you?");
    expect(
      container.querySelector('img[src="https://example.com/vince.png"]')
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="timeline-copy-button"]')
    ).not.toBeNull();
  });

  it("opens the referenced comment from the shared header action", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(
        createElement(CommentMentionDetail, { item: mention, onNavigate })
      );
    });

    const openButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="team-inbox-open-source"]'
    );
    expect(
      openButton?.closest('[data-testid="team-inbox-detail-actions"]')
    ).not.toBeNull();

    act(() => openButton?.click());

    expect(onNavigate).toHaveBeenCalledWith({
      kind: "open_session_comment",
      sessionId: "session-1",
      commentId: "comment-1",
      threadId: "thread-1",
      anchor: "turn-3",
    });
  });

  it("uses the same detail surface for Work Item comment mentions", () => {
    const onNavigate = vi.fn();
    const workItemMention: CommentMentionItem = {
      ...mention,
      target: {
        kind: "work_item_comment",
        orgId: "org-1",
        projectId: "project-1",
        workItemId: "ORG-42",
        commentId: "comment-2",
        workItemTitle: "Repository permissions",
      },
    };

    act(() => {
      root.render(
        createElement(CommentMentionDetail, {
          item: workItemMention,
          onNavigate,
        })
      );
    });

    expect(
      container.querySelector('[data-testid="team-inbox-mention-thread"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("Repository permissions");

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="team-inbox-open-source"]'
        )
        ?.click();
    });

    expect(onNavigate).toHaveBeenCalledWith({
      kind: "open_work_item",
      orgId: "org-1",
      projectId: "project-1",
      workItemId: "ORG-42",
    });
  });
});
