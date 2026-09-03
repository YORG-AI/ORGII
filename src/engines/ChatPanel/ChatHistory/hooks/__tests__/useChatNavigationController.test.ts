// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  isAgentOrgOverviewInteractionTarget,
  resolveConversationHistoryPageIndex,
} from "../useChatNavigationController";

afterEach(() => {
  document.body.replaceChildren();
});

const pages = [
  {
    startGroupIndex: 0,
    endGroupIndex: 1,
    flatStartIndex: 0,
    flatEndIndex: 3,
    cursorIdeSummary: null,
  },
  {
    startGroupIndex: 2,
    endGroupIndex: 4,
    flatStartIndex: 3,
    flatEndIndex: 8,
    cursorIdeSummary: null,
  },
];

describe("resolveConversationHistoryPageIndex", () => {
  it("uses the selected page when turn pagination is enabled", () => {
    expect(
      resolveConversationHistoryPageIndex({
        activeGroupIndex: 0,
        currentPageIndex: 1,
        pages,
        turnPaginationEnabled: true,
      })
    ).toBe(1);
  });

  it("maps the active visible group to a history page", () => {
    expect(
      resolveConversationHistoryPageIndex({
        activeGroupIndex: 3,
        currentPageIndex: 0,
        pages,
        turnPaginationEnabled: false,
      })
    ).toBe(1);
  });

  it("falls back to the latest page when no page contains the group", () => {
    expect(
      resolveConversationHistoryPageIndex({
        activeGroupIndex: 99,
        currentPageIndex: 0,
        pages,
        turnPaginationEnabled: false,
      })
    ).toBe(1);
  });
});

describe("isAgentOrgOverviewInteractionTarget", () => {
  it("treats a portalled Overview modal and its text nodes as owned UI", () => {
    const portal = document.createElement("div");
    portal.className = "agent-org-overview-owned-overlay";
    const label = document.createElement("label");
    label.textContent = "I understand this deletion is permanent.";
    portal.appendChild(label);
    document.body.appendChild(portal);

    expect(isAgentOrgOverviewInteractionTarget(label)).toBe(true);
    expect(isAgentOrgOverviewInteractionTarget(label.firstChild)).toBe(true);
  });

  it("still treats unrelated page content as outside the Overview", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    expect(isAgentOrgOverviewInteractionTarget(outside)).toBe(false);
  });
});
