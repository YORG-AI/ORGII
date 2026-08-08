import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import type { TeamInboxMention } from "@src/features/Org2Cloud/teamInboxMentionsClient";

import type { AssignedWorkItem } from "../domain";
import { teamInboxCacheAtom } from "../store";
import {
  TEAM_INBOX_CACHE_LIMIT,
  TeamInboxCoordinator,
  type TeamInboxCoordinatorDependencies,
  type TeamInboxCoordinatorScope,
} from "../teamInboxCoordinator";

function assignedItem(
  id: string,
  occurredAt = "2026-07-28T10:00:00.000Z"
): AssignedWorkItem {
  return {
    id,
    kind: "assigned_work_item",
    occurredAt,
    readAt: null,
    actor: { id: "assigner", displayName: "Assigner" },
    target: {
      kind: "work_item",
      projectId: "project-1",
      workItemId: id,
    },
    payload: {
      title: id,
      status: "todo",
      priority: "medium",
      assigneeMemberId: "viewer-1",
      updatedAt: occurredAt,
    },
  };
}

function mention(id: string): TeamInboxMention {
  return {
    comment: { id },
    session: { id: `session-${id}` },
    author: { userId: "author-1" },
    body: `Mention ${id}`,
    createdAt: "2026-07-28T11:00:00.000Z",
    readAt: null,
    commentCount: 1,
    threadCount: 1,
  };
}

function dependencies(
  overrides: Partial<TeamInboxCoordinatorDependencies> = {}
): TeamInboxCoordinatorDependencies {
  return {
    listLocalPage: vi.fn(async () => ({
      page: { items: [], nextCursor: null },
      unreadCount: 0,
    })),
    listInitialMentions: vi.fn(async () => ({
      mentions: [],
      unreadCount: 0,
    })),
    listMentions: vi.fn(async () => ({
      mentions: [],
      unreadCount: 0,
    })),
    markLocalRead: vi.fn(async () => true),
    markLocalUnread: vi.fn(async () => true),
    markAllLocalRead: vi.fn(async () => 0),
    setMentionRead: vi.fn(async () => ({
      readAt: "2026-07-28T12:00:00.000Z",
      unreadCount: 0,
    })),
    markAllMentionsRead: vi.fn(async () => ({
      readAt: "2026-07-28T12:00:00.000Z",
      unreadCount: 0,
    })),
    now: () => "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

function scope(
  overrides: Partial<TeamInboxCoordinatorScope> = {}
): TeamInboxCoordinatorScope {
  return {
    key: "viewer-1::local",
    viewerMemberIds: ["viewer-1"],
    accessToken: null,
    activeCloudOrgId: null,
    members: [],
    ...overrides,
  };
}

describe("TeamInboxCoordinator", () => {
  it("does not publish a new list revision when revalidation is unchanged", async () => {
    const listLocalPage = vi.fn(async () => ({
      page: { items: [assignedItem("same")], nextCursor: null },
      unreadCount: 1,
    }));
    const coordinator = new TeamInboxCoordinator(
      dependencies({ listLocalPage })
    );
    const store = createStore();
    const viewerScope = scope();

    await coordinator.refresh(store, viewerScope, "version-1");
    const firstSnapshot = store.get(teamInboxCacheAtom);
    const listener = vi.fn();
    const unsubscribe = store.sub(teamInboxCacheAtom, listener);

    await coordinator.refresh(store, viewerScope, "version-2");

    expect(store.get(teamInboxCacheAtom)).toBe(firstSnapshot);
    expect(store.get(teamInboxCacheAtom).items).toBe(firstSnapshot.items);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("shares the first-page cursor across consumers using the same store", async () => {
    const firstCursor = {
      occurredAt: "2026-07-28T10:00:00.000Z",
      itemKey: "assigned_work_item:first",
    };
    const listLocalPage = vi
      .fn<TeamInboxCoordinatorDependencies["listLocalPage"]>()
      .mockResolvedValueOnce({
        page: { items: [assignedItem("first")], nextCursor: firstCursor },
        unreadCount: 2,
      })
      .mockResolvedValueOnce({
        page: {
          items: [assignedItem("second", "2026-07-28T09:00:00.000Z")],
          nextCursor: null,
        },
        unreadCount: 2,
      });
    const coordinator = new TeamInboxCoordinator(
      dependencies({ listLocalPage })
    );
    const store = createStore();
    const viewerScope = scope();

    await coordinator.refresh(store, viewerScope, "version-1");
    await coordinator.loadMore(store, viewerScope);

    expect(listLocalPage).toHaveBeenNthCalledWith(
      2,
      ["viewer-1"],
      "all",
      firstCursor
    );
    expect(store.get(teamInboxCacheAtom).items.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
    expect(store.get(teamInboxCacheAtom).hasMore).toBe(false);
  });

  it("publishes a usable partial snapshot when one source fails", async () => {
    const coordinator = new TeamInboxCoordinator(
      dependencies({
        listLocalPage: vi.fn(async () => ({
          page: { items: [assignedItem("local")], nextCursor: null },
          unreadCount: 1,
        })),
        listInitialMentions: vi.fn(async () => {
          throw new Error("cloud unavailable");
        }),
      })
    );
    const store = createStore();

    await coordinator.refresh(
      store,
      scope({
        key: "viewer-1::org-1",
        accessToken: "token",
        activeCloudOrgId: "org-1",
      }),
      "version-1"
    );

    expect(store.get(teamInboxCacheAtom)).toMatchObject({
      unreadCount: 1,
      unreadCounts: { all: 1, assigned: 1, mentions: 0 },
      issue: { code: "partial_load", detail: "cloud unavailable" },
    });
    expect(store.get(teamInboxCacheAtom).items).toHaveLength(1);
  });

  it("keeps cloud results visible while reporting an unresolved local identity", async () => {
    const coordinator = new TeamInboxCoordinator(
      dependencies({
        listInitialMentions: vi.fn(async () => ({
          mentions: [mention("cloud-1")],
          unreadCount: 1,
        })),
      })
    );
    const store = createStore();

    await coordinator.refresh(
      store,
      scope({
        key: "::org-1",
        viewerMemberIds: [],
        accessToken: "token",
        activeCloudOrgId: "org-1",
        members: [
          {
            id: "someone-else",
            name: "Someone Else",
            email: "else@example.com",
            active: true,
          },
        ],
      }),
      "version-1"
    );

    expect(store.get(teamInboxCacheAtom).issue?.code).toBe(
      "identity_unresolved"
    );
    expect(store.get(teamInboxCacheAtom).items).toHaveLength(1);
  });

  it("keeps a failed source cursor retryable while appending a successful page", async () => {
    const localCursor = {
      occurredAt: "2026-07-28T10:00:00.000Z",
      itemKey: "assigned_work_item:first",
    };
    const listLocalPage = vi
      .fn<TeamInboxCoordinatorDependencies["listLocalPage"]>()
      .mockResolvedValueOnce({
        page: { items: [assignedItem("first")], nextCursor: localCursor },
        unreadCount: 2,
      })
      .mockResolvedValueOnce({
        page: {
          items: [assignedItem("second", "2026-07-28T09:00:00.000Z")],
          nextCursor: null,
        },
        unreadCount: 2,
      });
    const listMentions = vi
      .fn<TeamInboxCoordinatorDependencies["listMentions"]>()
      .mockRejectedValueOnce(new Error("temporary cloud failure"))
      .mockResolvedValueOnce({
        mentions: [mention("cloud-2")],
        unreadCount: 2,
      });
    const coordinator = new TeamInboxCoordinator(
      dependencies({
        listLocalPage,
        listInitialMentions: vi.fn(async () => ({
          mentions: [mention("cloud-1")],
          nextCursor: "cloud-cursor",
          unreadCount: 2,
        })),
        listMentions,
      })
    );
    const store = createStore();
    const viewerScope = scope({
      key: "viewer-1::org-1",
      accessToken: "token",
      activeCloudOrgId: "org-1",
    });

    await coordinator.refresh(store, viewerScope, "version-1");
    await coordinator.loadMore(store, viewerScope);

    expect(store.get(teamInboxCacheAtom).issue?.code).toBe("partial_load");
    expect(store.get(teamInboxCacheAtom).hasMore).toBe(true);
    expect(
      store.get(teamInboxCacheAtom).items.map((item) => item.id)
    ).toContain("second");

    await coordinator.loadMore(store, viewerScope);

    expect(listMentions).toHaveBeenNthCalledWith(
      2,
      "token",
      "org-1",
      "cloud-cursor",
      50,
      expect.any(AbortSignal)
    );
    expect(
      store.get(teamInboxCacheAtom).items.map((item) => item.id)
    ).toContain("cloud-comment:org-1:cloud-2");
    expect(store.get(teamInboxCacheAtom).hasMore).toBe(false);
  });

  it("ignores a late response after the viewer scope changes", async () => {
    let resolveOldCloud:
      | ((value: { mentions: TeamInboxMention[]; unreadCount: number }) => void)
      | undefined;
    const oldCloud = new Promise<{
      mentions: TeamInboxMention[];
      unreadCount: number;
    }>((resolve) => {
      resolveOldCloud = resolve;
    });
    const coordinator = new TeamInboxCoordinator(
      dependencies({
        listLocalPage: vi.fn(async (viewerIds) => ({
          page: {
            items: [assignedItem(viewerIds[0] ?? "unknown")],
            nextCursor: null,
          },
          unreadCount: 1,
        })),
        listInitialMentions: vi
          .fn<TeamInboxCoordinatorDependencies["listInitialMentions"]>()
          .mockImplementationOnce(async () => oldCloud)
          .mockResolvedValueOnce({ mentions: [], unreadCount: 0 }),
      })
    );
    const store = createStore();
    const oldScope = scope({
      key: "viewer-1::org-1",
      accessToken: "token",
      activeCloudOrgId: "org-1",
    });
    const nextScope = scope({
      key: "viewer-2::org-2",
      viewerMemberIds: ["viewer-2"],
      accessToken: "token",
      activeCloudOrgId: "org-2",
    });

    const staleRefresh = coordinator.refresh(store, oldScope, "version-1");
    await coordinator.refresh(store, nextScope, "version-1");
    resolveOldCloud?.({ mentions: [mention("stale")], unreadCount: 1 });
    await staleRefresh;

    expect(store.get(teamInboxCacheAtom).loadedForViewerKey).toBe(
      "viewer-2::org-2"
    );
    expect(store.get(teamInboxCacheAtom).items.map((item) => item.id)).toEqual([
      "viewer-2",
    ]);
  });

  it("rolls back an optimistic read mutation when persistence fails", async () => {
    const coordinator = new TeamInboxCoordinator(
      dependencies({
        listLocalPage: vi.fn(async () => ({
          page: { items: [assignedItem("first")], nextCursor: null },
          unreadCount: 1,
        })),
        markLocalRead: vi.fn(async () => {
          throw new Error("write failed");
        }),
      })
    );
    const store = createStore();
    const viewerScope = scope();
    await coordinator.refresh(store, viewerScope, "version-1");
    const item = store.get(teamInboxCacheAtom).items[0];

    const mutation = coordinator.markRead(store, viewerScope, item);
    expect(store.get(teamInboxCacheAtom).items[0].readAt).toBe(
      "2026-07-28T12:00:00.000Z"
    );
    expect(store.get(teamInboxCacheAtom).unreadCount).toBe(0);

    await expect(mutation).rejects.toThrow("write failed");
    expect(store.get(teamInboxCacheAtom).items[0].readAt).toBeNull();
    expect(store.get(teamInboxCacheAtom).unreadCount).toBe(1);
  });

  it("caps retained rows and closes cursors at the cache boundary", async () => {
    const coordinator = new TeamInboxCoordinator(
      dependencies({
        listLocalPage: vi.fn(async () => ({
          page: {
            items: Array.from(
              { length: TEAM_INBOX_CACHE_LIMIT + 25 },
              (_, index) =>
                assignedItem(
                  `item-${index}`,
                  new Date(Date.UTC(2026, 6, 28, 12, 0, index)).toISOString()
                )
            ),
            nextCursor: {
              occurredAt: "2026-07-28T00:00:00.000Z",
              itemKey: "more",
            },
          },
          unreadCount: TEAM_INBOX_CACHE_LIMIT + 25,
        })),
      })
    );
    const store = createStore();

    await coordinator.refresh(store, scope(), "version-1");

    expect(store.get(teamInboxCacheAtom).items).toHaveLength(
      TEAM_INBOX_CACHE_LIMIT
    );
    expect(store.get(teamInboxCacheAtom).hasMore).toBe(false);
  });
});
