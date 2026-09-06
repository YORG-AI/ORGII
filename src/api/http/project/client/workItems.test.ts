import { beforeEach, describe, expect, it, vi } from "vitest";

import { invalidateCache } from "../cache";
import { deleteDiscussionComment, editDiscussionComment } from "./discussions";
import {
  archiveQuickAction,
  listQuickActions,
  upsertQuickAction,
} from "./quickActions";
import { readWorkspaceWorkItemsData } from "./workItems";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("project client", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invalidateCache();
  });

  it("shares the canonical read cache and invalidates it on quick-action writes", async () => {
    const firstRows = [{ id: "qa-1", orgId: "org-1" }];
    invokeMock.mockResolvedValueOnce(firstRows);

    const first = listQuickActions("org-1");
    const concurrent = listQuickActions("org-1");
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      firstRows,
      firstRows,
    ]);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const request = {
      orgId: "org-1",
      name: "Review",
      targetKind: "agent",
      targetId: "builtin:sde",
      prompt: "Review this",
    };
    invokeMock.mockResolvedValueOnce({ ...firstRows[0], ...request });
    await upsertQuickAction(request);

    invokeMock.mockResolvedValueOnce([{ id: "qa-2", orgId: "org-1" }]);
    await expect(listQuickActions("org-1")).resolves.toEqual([
      { id: "qa-2", orgId: "org-1" },
    ]);

    invokeMock.mockResolvedValueOnce({ id: "qa-2", orgId: "org-1" });
    await archiveQuickAction("org-1", "qa-2");
    invokeMock.mockResolvedValueOnce([]);
    await expect(listQuickActions("org-1")).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(5);
  });

  it("normalizes omitted standalone todo arrays at the IPC boundary", async () => {
    invokeMock.mockResolvedValue({
      projectEntries: [],
      standaloneWorkItems: [
        {
          orgId: "personal-org",
          workItem: {
            body: "",
            filename: "WI-1",
            frontmatter: {
              id: "work-1",
              short_id: "WI-1",
              title: "No todos",
              status: "planned",
              priority: "none",
              labels: [],
              starred: false,
              created_at: "2026-08-13T00:00:00Z",
              updated_at: "2026-08-13T00:00:00Z",
            },
          },
        },
      ],
      orgs: [],
    });

    const data = await readWorkspaceWorkItemsData({ readBucket: "active" });

    expect(data.standaloneWorkItems[0]?.workItem.frontmatter.todos).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith(
      "project_read_workspace_work_items_data",
      expect.objectContaining({ readBucket: "active" })
    );
  });

  it("passes per-comment revision preconditions through the IPC boundary", async () => {
    invokeMock.mockResolvedValue([]);
    const scope = {
      projectSlug: "demo",
      orgId: "personal-org",
      workItemId: "WI-1",
    };

    await editDiscussionComment({
      scope,
      commentId: "comment-1",
      actorId: "member-1",
      content: "my version",
      expectedRevision: 4,
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "project_discussion_edit_comment",
      {
        request: {
          ...scope,
          commentId: "comment-1",
          actorId: "member-1",
          content: "my version",
          expectedRevision: 4,
        },
      }
    );

    await deleteDiscussionComment({
      scope,
      commentId: "comment-1",
      actorId: "member-1",
      expectedRevision: 5,
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "project_discussion_delete_comment",
      {
        request: {
          ...scope,
          commentId: "comment-1",
          actorId: "member-1",
          expectedRevision: 5,
        },
      }
    );
  });
});
