import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GitHubIssueTimelineItem } from "@src/api/tauri/github";

import { IssueTimelineEventRow } from "../IssueTimelineEvent";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === "string"
        ? fallback
        : typeof fallback?.defaultValue === "string"
          ? fallback.defaultValue.replace(/{{(\w+)}}/g, (_, name: string) =>
              String(fallback[name] ?? "")
            )
          : key,
  }),
}));

function timelineItem(
  overrides: Partial<GitHubIssueTimelineItem>
): GitHubIssueTimelineItem {
  return {
    id: 1,
    event: "assigned",
    created_at: "2026-07-21T05:55:44Z",
    actor: { login: "beruro", avatar_url: "https://example.com/actor.png" },
    body: null,
    html_url: null,
    assignee: null,
    label: null,
    milestone: null,
    rename: null,
    source: null,
    commit_id: null,
    lock_reason: null,
    ...overrides,
  };
}

describe("IssueTimelineEventRow", () => {
  it("renders assignment actors, targets, and an exact timestamp", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueTimelineEventRow, {
        item: timelineItem({
          assignee: {
            login: "Harry19081",
            avatar_url: "https://example.com/assignee.png",
          },
        }),
      })
    );

    expect(markup).toContain("beruro");
    expect(markup).toContain("assigned");
    expect(markup).toContain("Harry19081");
    expect(markup).not.toContain("assignee.png");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('dateTime="2026-07-21T05:55:44Z"');
    expect(markup).not.toContain(">today<");
  });

  it("preserves linked pull request identity and its GitHub URL", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueTimelineEventRow, {
        item: timelineItem({
          id: null,
          event: "cross-referenced",
          source: {
            number: 460,
            title: "fix(chat): refresh question status after answer",
            html_url: "https://github.com/yorgai/ORG2/pull/460",
            state: "open",
            is_pull_request: true,
          },
        }),
      })
    );

    expect(markup).toContain("referenced this issue from");
    expect(markup).toContain("#460");
    expect(markup).toContain('href="https://github.com/yorgai/ORG2/pull/460"');
    expect(markup).toContain("fix(chat): refresh question status after answer");
    expect(markup).toContain('class="lucide lucide-git-pull-request');
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("overflow-hidden");
    expect(markup).toContain("min-w-0 truncate");
  });

  it("shows only the new title for rename events", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueTimelineEventRow, {
        item: timelineItem({
          event: "renamed",
          rename: {
            from: "Old issue title",
            to: "New issue title",
          },
        }),
      })
    );

    expect(markup).toContain("renamed this issue to");
    expect(markup).toContain("New issue title");
    expect(markup).not.toContain("Old issue title");
    expect(markup).not.toContain("renamed this issue from");
  });

  it("keeps future event types visible through a readable fallback", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueTimelineEventRow, {
        item: timelineItem({ event: "future_event_type" }),
      })
    );

    expect(markup).toContain("future event type");
  });

  it.each([
    ["pinned", "pin"],
    ["unpinned", "pin-off"],
    ["mentioned", "message-square"],
    ["marked_as_duplicate", "copy-check"],
    ["unmarked_as_duplicate", "copy-x"],
    ["transferred", "arrow-right-left"],
    ["converted_to_discussion", "messages-square"],
    ["subscribed", "bell"],
    ["unsubscribed", "bell-off"],
  ])(
    "uses the %s event icon instead of the generic fallback",
    (event, icon) => {
      const markup = renderToStaticMarkup(
        createElement(IssueTimelineEventRow, {
          item: timelineItem({ event }),
        })
      );

      expect(markup).toContain(`lucide-${icon}`);
      expect(markup).not.toContain("lucide-activity");
    }
  );
});
