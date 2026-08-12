import { describe, expect, it } from "vitest";

import type {
  WorkItemData,
  WorkspaceWorkItemsData,
} from "@src/api/http/project";

import { readWorkspaceBucket } from "./ProjectWorkItemsTabContentDataLoader";

function standaloneWorkItem(id: string, shortId: string): WorkItemData {
  return {
    filename: shortId,
    body: "",
    frontmatter: {
      id,
      short_id: shortId,
      title: id,
      status: "planned",
      priority: "none",
      labels: [],
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
      starred: false,
      todos: [],
    },
  };
}

describe("readWorkspaceBucket", () => {
  it("keeps each standalone row in its owning organization", () => {
    const workspaceData: WorkspaceWorkItemsData = {
      projectEntries: [],
      standaloneWorkItems: [
        {
          orgId: "personal-org",
          workItem: standaloneWorkItem("personal-row", "WI-0001"),
        },
        {
          orgId: "cloud-org",
          workItem: standaloneWorkItem("cloud-row", "WI-0001"),
        },
      ],
      orgs: [
        {
          id: "personal-org",
          name: "Personal",
          slug: "personal",
          org_key: "personal-org",
          source: "local",
          sync_provider: "local",
          created_at: "",
          updated_at: "",
        },
        {
          id: "cloud-org",
          name: "Cloud",
          slug: "cloud",
          org_key: "cloud-org",
          source: "cloud",
          sync_provider: "org2_cloud",
          created_at: "",
          updated_at: "",
        },
      ],
    };

    const entries = readWorkspaceBucket({
      workspaceData,
      linearWorkItems: [],
    });

    expect(entries).toHaveLength(2);
    expect(
      entries.map(({ orgId, orgName, item }) => ({
        orgId,
        orgName,
        rowId: item.session_id,
      }))
    ).toEqual([
      {
        orgId: "personal-org",
        orgName: "Personal",
        rowId: "personal-row",
      },
      { orgId: "cloud-org", orgName: "Cloud", rowId: "cloud-row" },
    ]);
  });
});
