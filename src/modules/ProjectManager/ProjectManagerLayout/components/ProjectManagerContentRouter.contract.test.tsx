import { describe, expect, it } from "vitest";

import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import { renderActiveContent } from "./ProjectManagerContentRouter";

function tab(type: WorkStationTab["type"]): WorkStationTab {
  return {
    id: `${type}:test`,
    type,
    category: "project",
    title: type,
    icon: "GitFork",
    data: type === "session-journey" ? { sessionId: "session-1" } : {},
    closable: true,
  };
}

describe("ProjectManagerContentRouter Journey production route", () => {
  for (const type of [
    "project-tree",
    "project-journey",
    "session-journey",
  ] as const) {
    it(`routes ${type} through the unified project host`, () => {
      const node = renderActiveContent({
        repoPath: "/repo",
        activeTab: tab(type),
        hasNoTabs: false,
        projectQuickActions: [],
      });

      expect(node).not.toBeNull();
      expect(
        (node as { props?: { tab?: WorkStationTab } }).props?.tab?.type
      ).toBe(type);
    });
  }

  it("passes the keyed chat target through the production project host", () => {
    const activeTab = {
      ...tab("chat-session"),
      data: { sessionId: "session-1", initialMessageId: "message-9" },
    };
    const node = renderActiveContent({
      repoPath: "/repo",
      activeTab,
      hasNoTabs: false,
      projectQuickActions: [],
    }) as {
      props: {
        children: { props: { children: { props: Record<string, unknown> } } };
      };
    };

    expect(node.props.children.props.children.props.initialMessageId).toBe(
      "message-9"
    );
  });
});
