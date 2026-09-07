import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  archiveLocalTeamInboxItem,
  listLocalTeamInboxMutedKinds,
  listLocalTeamInboxPage,
  setLocalTeamInboxKindMuted,
  unarchiveLocalTeamInboxItem,
} from "../api";

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

  it("maps the owning project's synced repository onto Work Item targets", async () => {
    vi.mocked(invoke).mockResolvedValue({
      items: [
        {
          id: "work_item_assigned:work-item-1",
          kind: "work_item_assigned",
          occurredAt: Date.parse("2026-07-29T08:00:00.000Z"),
          target: {
            type: "work_item",
            orgId: "org-invite-test",
            projectId: "project-1",
            projectSlug: "orgii-issues",
            repository: "https://github.com/org2AI/ORG2.git",
            workItemId: "work-item-1",
            shortId: "WI-0001",
          },
          payload: {
            type: "work_item_assigned",
            title: "Fix issue source",
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
      projectId: "orgii-issues",
      repository: "https://github.com/org2AI/ORG2.git",
      workItemId: "WI-0001",
    });
  });

  it("preserves subscription and Run failure semantics on Work Item rows", async () => {
    vi.mocked(invoke).mockResolvedValue({
      items: [
        {
          id: "work-item-event:1",
          kind: "work_item_run_failed",
          occurredAt: Date.parse("2026-08-08T10:00:00.000Z"),
          target: {
            type: "work_item",
            orgId: "personal-org",
            projectSlug: "demo",
            workItemId: "row-1",
            shortId: "AAA-0001",
          },
          payload: {
            type: "work_item_updated",
            title: "Durable dispatch",
            eventKind: "run_failed",
            status: "in_progress",
            priority: "high",
            recipientMemberId: "member-1",
            summary: "The latest Run failed",
          },
        },
      ],
      unreadCount: 1,
    });

    const result = await listLocalTeamInboxPage(["member-1"], "all");

    expect(result.page.items[0]).toMatchObject({
      id: "work-item-event:1",
      kind: "work_item_run_failed",
      target: {
        kind: "work_item",
        orgId: "personal-org",
        projectId: "demo",
        workItemId: "AAA-0001",
      },
      payload: {
        title: "Durable dispatch",
        eventKind: "run_failed",
        recipientMemberId: "member-1",
        summary: "The latest Run failed",
      },
    });
  });

  it("promotes child completion into its own frontend event kind", async () => {
    vi.mocked(invoke).mockResolvedValue({
      items: [
        {
          id: "work_item_subscription_event:event-child",
          kind: "work_item_updated",
          occurredAt: Date.parse("2026-08-08T10:00:00.000Z"),
          target: {
            type: "work_item",
            orgId: "personal-org",
            projectSlug: "demo",
            workItemId: "parent-row",
            shortId: "AAA-0001",
          },
          payload: {
            type: "work_item_updated",
            title: "Child task",
            eventKind: "child_completed",
            status: "in_progress",
            priority: "high",
            recipientMemberId: "member-1",
          },
        },
      ],
      unreadCount: 1,
    });

    const result = await listLocalTeamInboxPage(["member-1"], "all");

    expect(result.page.items[0]).toMatchObject({
      kind: "child_completed",
      source: "local",
      payload: {
        eventKind: "child_completed",
        recipientMemberId: "member-1",
      },
    });
  });

  it("uses viewer-scoped archive commands and intersects category mutes", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(["run_failed", "child_completed"])
      .mockResolvedValueOnce(["run_failed"]);

    await expect(
      archiveLocalTeamInboxItem(["member-a"], "work_item_assigned:work-1")
    ).resolves.toBe(true);
    await expect(
      unarchiveLocalTeamInboxItem(["member-a"], "work_item_assigned:work-1")
    ).resolves.toBe(true);
    await expect(
      listLocalTeamInboxMutedKinds(["member-a", "member-alias"])
    ).resolves.toEqual(["run_failed"]);

    expect(vi.mocked(invoke).mock.calls).toEqual([
      [
        "team_inbox_archive",
        {
          viewerMemberIds: ["member-a"],
          itemId: "work_item_assigned:work-1",
        },
      ],
      [
        "team_inbox_unarchive",
        {
          viewerMemberIds: ["member-a"],
          itemId: "work_item_assigned:work-1",
        },
      ],
      ["team_inbox_list_muted_kinds", { recipientId: "member-a" }],
      ["team_inbox_list_muted_kinds", { recipientId: "member-alias" }],
    ]);
  });

  it("applies category mutes to every current viewer identity", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(["run_failed"])
      .mockResolvedValueOnce(["run_failed"])
      .mockResolvedValueOnce(["run_failed"])
      .mockResolvedValueOnce(["run_failed"]);

    await expect(
      setLocalTeamInboxKindMuted(
        ["member-a", "member-alias"],
        "run_failed",
        true
      )
    ).resolves.toEqual(["run_failed"]);

    expect(vi.mocked(invoke).mock.calls.slice(0, 2)).toEqual([
      [
        "team_inbox_set_kind_muted",
        { recipientId: "member-a", kind: "run_failed", muted: true },
      ],
      [
        "team_inbox_set_kind_muted",
        { recipientId: "member-alias", kind: "run_failed", muted: true },
      ],
    ]);
  });
});
