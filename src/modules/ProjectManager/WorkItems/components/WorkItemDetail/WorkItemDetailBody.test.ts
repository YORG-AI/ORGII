import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/ui/useResizeHandle", () => ({
  useResizeHandle: () => ({ handleMouseDown: vi.fn(), isResizing: false }),
}));

vi.mock("../WorkItemContent", () => ({
  default: ({ presentation }: { presentation?: string }) =>
    createElement("div", {
      "data-testid": "conversation",
      "data-presentation": presentation,
    }),
}));

vi.mock("../WorkItemProperties", () => ({
  default: () => createElement("div", { "data-testid": "properties" }),
}));

vi.mock("@src/modules/shared/components/GitHubLinkedReferences/lazy", () => ({
  default: ({ references }: { references: readonly unknown[] }) =>
    createElement("div", {
      "data-testid": "linked",
      "data-reference-count": references.length,
    }),
}));

const { WorkItemDetailBody } = await import("./WorkItemDetailBody");

const workItem: WorkItem = {
  session_id: "work-item-1",
  user_id: "user-1",
  name: "Linked detail",
  status: "planned",
  spec: "See acme/app#9",
  star: false,
  target_date: null,
  created_time: "2026-09-03T00:00:00Z",
  updated_time: "2026-09-03T00:00:00Z",
};

function renderBody(activeTab: "conversation" | "linked") {
  return renderToStaticMarkup(
    createElement(WorkItemDetailBody, {
      displayWorkItem: workItem,
      activeTab,
      linkedReferences: [
        {
          repoFullName: "acme/app",
          number: 9,
          kind: "unknown",
          source: "acme/app#9",
        },
      ],
      propertiesOpen: false,
      infoPanelWidth: 240,
      setInfoPanelWidth: vi.fn(),
      availableProjects: [],
      availableMilestones: [],
      availableLabels: [],
      availableMembers: [],
      availableAgents: [],
      availableOrgs: [],
      showTime: true,
      onUpdateWorkItem: vi.fn(),
      onUpdateWorkItemImmediate: vi.fn(),
      onOpenSession: vi.fn(),
      onOpenFileDiff: vi.fn(),
      onReviewAllFiles: vi.fn(),
      onCreatePr: vi.fn().mockResolvedValue({}),
    })
  );
}

describe("WorkItemDetailBody", () => {
  it("does not mount Linked content while Conversation is active", () => {
    const markup = renderBody("conversation");

    expect(markup).toContain('data-testid="conversation"');
    expect(markup).toContain('data-presentation="thread"');
    expect(markup).not.toContain('data-testid="linked"');
  });

  it("mounts the shared Linked content when selected", () => {
    const markup = renderBody("linked");

    expect(markup).toContain('data-testid="linked"');
    expect(markup).toContain('data-reference-count="1"');
  });
});
