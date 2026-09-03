import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DeliveryBox01Icon } from "@src/icons";

import {
  buildLinkedSessionRows,
  buildProjectOverviewRow,
  buildProjectRow,
  buildWorkItemRow,
} from "./menuRows";
import type { SidebarWorkItem } from "./types";

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type, size }: { type: string; size: number }) =>
    createElement("span", {
      "data-integration-icon": type,
      "data-icon-size": size,
    }),
}));

const baseWorkItem = {
  id: "work-item-1",
  shortId: "ORG-1",
  title: "Imported issue",
  status: "backlog",
  projectSlug: "orgii-issues",
  projectSyncAdapterId: null,
  source: "local",
} as SidebarWorkItem;

const t = ((key: string) => key) as Parameters<typeof buildWorkItemRow>[0];

describe("buildWorkItemRow", () => {
  it("shows both status and GitHub source icons for imported issues", () => {
    const row = buildWorkItemRow(t, {
      ...baseWorkItem,
      projectSyncAdapterId: "github",
    });

    const markup = renderToStaticMarkup(
      createElement("div", null, row.iconElement)
    );

    expect(markup).toContain('data-testid="sidebar-github-work-item-icons"');
    expect(markup).toContain('data-integration-icon="github"');
    expect(markup).toContain("color:");
  });

  it("keeps local Work Items status-only", () => {
    const row = buildWorkItemRow(t, baseWorkItem);
    const markup = renderToStaticMarkup(
      createElement("div", null, row.iconElement)
    );

    expect(markup).not.toContain("sidebar-github-work-item-icons");
    expect(markup).not.toContain("data-integration-icon");
    expect(markup).toContain("color:");
  });

  it("adds the session disclosure action when linked sessions are available", () => {
    const onToggle = vi.fn();
    const row = buildWorkItemRow(
      t,
      {
        ...baseWorkItem,
        linkedSessions: [
          {
            session_id: "session-1",
            session_type: "native",
            agent_role: "sde",
            started_at: "2026-07-21T08:00:00Z",
            status: "running",
            cost_usd: 0,
            total_tokens: 0,
          },
        ],
      },
      false,
      { expanded: false, onToggle }
    );

    expect(row.showMoreActions).toBe(true);
    expect(row.rowActions).toHaveLength(1);
    expect(row.rowActions?.[0]?.active).toBe(false);
    expect(row.rowActions?.[0]?.dataTestId).toBe(
      "sidebar-work-item-linked-sessions-toggle-work-item-1"
    );
    row.rowActions?.[0]?.onClick({} as React.MouseEvent<HTMLButtonElement>);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("builds indented linked-session rows and skips pending placeholders", () => {
    const rows = buildLinkedSessionRows(t, {
      ...baseWorkItem,
      linkedSessions: [
        {
          session_id: "pending",
          session_type: "native",
          agent_role: "sde",
          started_at: "2026-07-21T08:00:00Z",
          status: "running",
          cost_usd: 0,
          total_tokens: 0,
        },
        {
          session_id: "session-running",
          session_type: "native",
          agent_role: "sde",
          started_at: "2026-07-21T08:00:00Z",
          status: "running",
          cost_usd: 0,
          total_tokens: 0,
        },
        {
          session_id: "session-review",
          session_type: "cli",
          agent_role: "review",
          started_at: "2026-07-21T08:05:00Z",
          completed_at: "2026-07-21T08:10:00Z",
          status: "completed",
          cost_usd: 0,
          total_tokens: 0,
          result_preview: "123456789012345678901234567890extra",
        },
      ],
    });

    expect(rows.map((row) => row.id)).toEqual([
      "session-running",
      "session-review",
    ]);
    expect(rows.every((row) => row.showIndentGuide)).toBe(true);
    expect(rows[0]?.iconBadge).toBeDefined();
    expect(rows[1]?.iconBadge).toBeDefined();
    expect(rows[1]?.label).toBe("123456789012345678901234567890");
    expect(rows[0]?.dragPayload?.path).toBe("session://session-running");
  });
});

describe("project rows", () => {
  it("uses the same box icon for imported projects and their overviews", () => {
    const row = buildProjectRow(
      t,
      "orgii-issues",
      "ORGII issues",
      false,
      "github"
    );
    const overviewRow = buildProjectOverviewRow(
      t,
      "orgii-issues",
      "ORGII issues",
      "github"
    );

    for (const projectRow of [row, overviewRow]) {
      expect(projectRow.icon).toBe(DeliveryBox01Icon);
      expect(projectRow.iconName).toBe("box");
      expect(projectRow.iconElement).toBeUndefined();
      expect(projectRow.visualTone).toBeUndefined();
    }
  });

  it("keeps the default project icon for local projects", () => {
    const row = buildProjectRow(t, "local-project", "Local project");

    expect(row.icon).toBeDefined();
    expect(row.iconName).toBe("box");
    expect(row.iconElement).toBeUndefined();
    expect(row.visualTone).toBeUndefined();
  });
});
