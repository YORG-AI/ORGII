import { describe, expect, it } from "vitest";

import { buildByOrgMenuItems } from "./groupingBuilders";
import type { SidebarProject } from "./types";

const project = {
  projectData: {
    slug: "orgii-issues",
    meta: {
      name: "ORGII issues",
      updated_at: "2026-09-03T00:00:00.000Z",
    },
  },
  projectSyncAdapterId: "github",
  orgId: "personal",
  orgName: "Personal",
  labelMap: new Map(),
  memberMap: new Map(),
} as SidebarProject;

const t = ((key: string) => key) as Parameters<
  typeof buildByOrgMenuItems
>[0]["t"];

describe("buildByOrgMenuItems", () => {
  it("keeps the sidebar focused on projects without a Work Items section", () => {
    const items = buildByOrgMenuItems({
      localProjects: [project],
      pendingSync: { projectIds: new Set() },
      searchQuery: "",
      t,
    });

    expect(items.map((item) => item.id)).toEqual([
      "separator-recent-projects",
      "projects-project-overview:orgii-issues",
    ]);
    expect(
      items.some((item) => item.label === "projects:workItems.label")
    ).toBe(false);
  });
});
