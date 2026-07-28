import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import TeamInboxList from "../components/TeamInboxList";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function renderEmptyList(query: string): string {
  return renderToStaticMarkup(
    createElement(TeamInboxList, {
      filter: "all",
      items: [],
      recencyAnchorMs: Date.UTC(2026, 6, 28),
      selectedItemId: null,
      totalUnread: 0,
      unreadCounts: { all: 0, mentions: 0, assigned: 0 },
      query,
      loading: false,
      onQueryChange: vi.fn(),
      onFilterChange: vi.fn(),
      onSelectItem: vi.fn(),
      hasMore: true,
      onLoadMore: vi.fn(),
    })
  );
}

describe("TeamInboxList pagination", () => {
  it("keeps Load more reachable when the current search has no visible rows", () => {
    const markup = renderEmptyList("missing");

    expect(markup).toContain("teamInbox.empty.noResults.title");
    expect(markup).toContain("teamInbox.loadMore");
  });

  it("does not point assistive technology at an unmounted active row", () => {
    expect(renderEmptyList("")).not.toContain("aria-activedescendant");
  });
});
