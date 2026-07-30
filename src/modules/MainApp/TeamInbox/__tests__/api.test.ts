import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listLocalTeamInboxPage } from "../api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("Team Inbox API mapping", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("preserves the owning Cloud Org on standalone Work Item targets", async () => {
    vi.mocked(invoke).mockResolvedValue({
      items: [
        {
          id: "assigned:WI-0001",
          kind: "work_item_assigned",
          occurredAt: Date.parse("2026-07-29T08:00:00.000Z"),
          actor: {
            id: "1106510024",
            displayName: "1106510024",
          },
          target: {
            type: "work_item",
            orgId: "org-invite-test",
            workItemId: "work-item-1",
            shortId: "WI-0001",
          },
          payload: {
            type: "work_item_assigned",
            title: "Hand off Session",
            status: "planned",
            priority: "medium",
            assigneeMemberId: "ahanafish",
          },
        },
      ],
      unreadCount: 1,
    });

    const result = await listLocalTeamInboxPage(["ahanafish"], "assigned");

    expect(result.page.items[0]?.target).toEqual({
      kind: "work_item",
      orgId: "org-invite-test",
      projectId: "",
      workItemId: "WI-0001",
    });
  });
});
