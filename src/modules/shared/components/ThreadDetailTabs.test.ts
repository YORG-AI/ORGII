import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ThreadDetailTabs from "./ThreadDetailTabs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

describe("ThreadDetailTabs", () => {
  it("uses the shared detail-tab contract for Conversation and Related items", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadDetailTabs, {
        activeTab: "linked",
        conversationCount: 3,
        linkedCount: 2,
        onChange: vi.fn(),
        idPrefix: "work-item-detail",
        variant: "header",
      })
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("h-9");
    expect(markup).not.toContain("h-10");
    expect(markup).toContain('id="work-item-detail-tab-conversation"');
    expect(markup).toContain('id="work-item-detail-tab-linked"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain(">Conversation</span>");
    expect(markup).toContain(">Related items</span>");
    expect(markup).toContain('data-icon="link-2"');
    expect(markup).toContain(">3</span>");
    expect(markup).toContain(">2</span>");
  });

  it("uses shared count placeholders while a detail is loading", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadDetailTabs, {
        activeTab: "conversation",
        conversationCountLoading: true,
        linkedCountLoading: true,
        idPrefix: "issue-detail",
      })
    );

    expect(
      markup.match(/data-testid="detail-tab-count-skeleton"/g)
    ).toHaveLength(2);
  });
});
