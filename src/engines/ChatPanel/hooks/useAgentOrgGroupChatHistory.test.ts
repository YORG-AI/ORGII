import { describe, expect, it } from "vitest";

import type { AgentOrgGroupChatHistoryRow } from "@src/api/tauri/agent";

import { agentOrgGroupChatHistoryTestApi } from "./useAgentOrgGroupChatHistory";

function row(
  inboxId: number,
  overrides: Partial<AgentOrgGroupChatHistoryRow> = {}
): AgentOrgGroupChatHistoryRow {
  return {
    inboxId,
    targetMemberId: "reviewer",
    targetMemberName: "Reviewer",
    text: `message-${inboxId}`,
    displayText: `@Reviewer message-${inboxId}`,
    createdAt: `2026-07-17T00:00:${String(inboxId).padStart(2, "0")}Z`,
    readAt: null,
    deliveryResolution: null,
    ...overrides,
  };
}

function rows(from: number, through: number): AgentOrgGroupChatHistoryRow[] {
  return Array.from({ length: through - from + 1 }, (_, index) =>
    row(from + index)
  );
}

const request = { scopeKey: "root-session", generation: 3 } as const;

function olderRequest(beforeId: number) {
  return { ...request, beforeId };
}

describe("Agent Org Group Chat durable history", () => {
  it("loads the initial bounded page in durable Inbox order", () => {
    const initial = agentOrgGroupChatHistoryTestApi.createHistoryModel(
      request.scopeKey,
      request.generation
    );
    const loaded = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      initial,
      request,
      {
        rows: [row(5), row(3), row(4)],
        hasMore: true,
        nextBeforeId: 3,
      }
    );

    expect(loaded.rows.map((item) => item.inboxId)).toEqual([3, 4, 5]);
    expect(loaded).toMatchObject({
      hasMore: true,
      nextBeforeId: 3,
      initialized: true,
      refreshing: false,
      error: null,
    });
  });

  it("merges older pages without duplicates or reordering", () => {
    const initial = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      agentOrgGroupChatHistoryTestApi.createHistoryModel(
        request.scopeKey,
        request.generation
      ),
      request,
      {
        rows: [row(3, { deliveryResolution: "superseded" }), row(4), row(5)],
        hasMore: true,
        nextBeforeId: 3,
      }
    );
    const loaded = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      initial,
      olderRequest(3),
      {
        rows: [row(1), row(2), row(3, { readAt: "2026-07-17T00:01:00Z" })],
        hasMore: false,
      }
    );

    expect(loaded.rows.map((item) => item.inboxId)).toEqual([1, 2, 3, 4, 5]);
    expect(loaded.rows.find((item) => item.inboxId === 3)?.readAt).toBe(
      "2026-07-17T00:01:00Z"
    );
    expect(
      loaded.rows.find((item) => item.inboxId === 3)?.deliveryResolution
    ).toBe("superseded");
    expect(loaded).toMatchObject({ hasMore: false, nextBeforeId: null });
  });

  it("refreshes recent rows without dropping older pages or moving their cursor", () => {
    const first = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      agentOrgGroupChatHistoryTestApi.createHistoryModel(
        request.scopeKey,
        request.generation
      ),
      request,
      { rows: [row(3), row(4)], hasMore: true, nextBeforeId: 3 }
    );
    const older = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      first,
      olderRequest(3),
      { rows: [row(1), row(2)], hasMore: false }
    );
    const refreshed = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      older,
      request,
      {
        rows: [row(4, { deliveryResolution: "cancelled" }), row(5)],
        hasMore: true,
        nextBeforeId: 4,
      }
    );

    expect(refreshed.rows.map((item) => item.inboxId)).toEqual([1, 2, 3, 4, 5]);
    expect(
      refreshed.rows.find((item) => item.inboxId === 4)?.deliveryResolution
    ).toBe("cancelled");
    expect(refreshed).toMatchObject({ hasMore: false, nextBeforeId: null });
  });

  it("keeps a cursor for more than one page of messages added while offline", () => {
    const initial = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      agentOrgGroupChatHistoryTestApi.createHistoryModel(
        request.scopeKey,
        request.generation
      ),
      request,
      { rows: rows(1, 100), hasMore: false }
    );
    const refreshed = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      initial,
      request,
      { rows: rows(301, 400), hasMore: true, nextBeforeId: 301 }
    );

    expect(refreshed).toMatchObject({
      hasMore: true,
      nextBeforeId: 301,
      continuationFrontiers: [{ hasMore: false, nextBeforeId: null }],
    });

    const pageTwo = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      refreshed,
      olderRequest(301),
      { rows: rows(201, 300), hasMore: true, nextBeforeId: 201 }
    );
    const pageThree = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      pageTwo,
      olderRequest(201),
      { rows: rows(101, 200), hasMore: true, nextBeforeId: 101 }
    );
    const overlap = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      pageThree,
      olderRequest(101),
      { rows: rows(1, 100), hasMore: false }
    );

    expect(overlap.rows).toHaveLength(400);
    expect(overlap.rows.map((item) => item.inboxId)).toEqual(
      rows(1, 400).map((item) => item.inboxId)
    );
    expect(overlap).toMatchObject({
      hasMore: false,
      nextBeforeId: null,
      continuationFrontiers: [],
    });
  });

  it("adopts the new cursor when an initialized empty history gains multiple pages", () => {
    const empty = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      agentOrgGroupChatHistoryTestApi.createHistoryModel(
        request.scopeKey,
        request.generation
      ),
      request,
      { rows: [], hasMore: false }
    );
    const refreshed = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      empty,
      request,
      { rows: rows(201, 300), hasMore: true, nextBeforeId: 201 }
    );

    expect(refreshed).toMatchObject({
      hasMore: true,
      nextBeforeId: 201,
      continuationFrontiers: [],
    });

    const middle = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      refreshed,
      olderRequest(201),
      { rows: rows(101, 200), hasMore: true, nextBeforeId: 101 }
    );
    const completed = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      middle,
      olderRequest(101),
      { rows: rows(1, 100), hasMore: false }
    );
    expect(completed.rows).toHaveLength(300);
    expect(completed).toMatchObject({ hasMore: false, nextBeforeId: null });
  });

  it("resumes the older cursor that existed before a refresh gap", () => {
    const initial = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      agentOrgGroupChatHistoryTestApi.createHistoryModel(
        request.scopeKey,
        request.generation
      ),
      request,
      { rows: rows(501, 600), hasMore: true, nextBeforeId: 501 }
    );
    let model = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      initial,
      request,
      { rows: rows(801, 900), hasMore: true, nextBeforeId: 801 }
    );
    model = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      model,
      olderRequest(801),
      { rows: rows(701, 800), hasMore: true, nextBeforeId: 701 }
    );
    model = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      model,
      olderRequest(701),
      { rows: rows(601, 700), hasMore: true, nextBeforeId: 601 }
    );
    model = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      model,
      olderRequest(601),
      { rows: rows(501, 600), hasMore: true, nextBeforeId: 501 }
    );

    expect(model.rows).toHaveLength(400);
    expect(model).toMatchObject({
      hasMore: true,
      nextBeforeId: 501,
      continuationFrontiers: [],
    });
  });

  it("keeps a refresh-adopted gap cursor when a stale older page lands", () => {
    let model = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      agentOrgGroupChatHistoryTestApi.createHistoryModel(
        request.scopeKey,
        request.generation
      ),
      request,
      { rows: rows(100, 150), hasMore: true, nextBeforeId: 100 }
    );
    model = agentOrgGroupChatHistoryTestApi.beginLoadOlder(
      model,
      olderRequest(100)
    );

    // While the older page is in flight, a refresh jumps past a gap and
    // adopts the new page's cursor, stacking the pre-gap frontier.
    model = agentOrgGroupChatHistoryTestApi.applyRefreshPage(model, request, {
      rows: rows(200, 250),
      hasMore: true,
      nextBeforeId: 200,
    });
    expect(model).toMatchObject({
      nextBeforeId: 200,
      continuationFrontiers: [{ hasMore: true, nextBeforeId: 100 }],
    });

    // The stale older page must merge its rows without clobbering the
    // refresh-adopted cursor; otherwise the gap 151..199 becomes unreachable.
    model = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      model,
      olderRequest(100),
      { rows: rows(50, 99), hasMore: true, nextBeforeId: 50 }
    );
    expect(model).toMatchObject({
      nextBeforeId: 200,
      loadingOlder: false,
      continuationFrontiers: [{ hasMore: true, nextBeforeId: 100 }],
    });

    // Walking the gap overlaps already-loaded rows and resumes the stacked
    // frontier, then the final page below it completes the history.
    model = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      model,
      olderRequest(200),
      { rows: rows(100, 199), hasMore: true, nextBeforeId: 100 }
    );
    expect(model).toMatchObject({
      hasMore: true,
      nextBeforeId: 100,
      continuationFrontiers: [],
    });
    model = agentOrgGroupChatHistoryTestApi.applyOlderPage(
      model,
      olderRequest(100),
      { rows: rows(1, 99), hasMore: false }
    );

    expect(model.rows.map((item) => item.inboxId)).toEqual(
      rows(1, 250).map((item) => item.inboxId)
    );
    expect(model).toMatchObject({ hasMore: false, nextBeforeId: null });
  });

  it("bounds stacked refresh gaps and falls back to a complete cursor scan", () => {
    let model = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      agentOrgGroupChatHistoryTestApi.createHistoryModel(
        request.scopeKey,
        request.generation
      ),
      request,
      { rows: [row(1)], hasMore: false }
    );
    for (let page = 1; page <= 33; page += 1) {
      const inboxId = page * 100 + 1;
      model = agentOrgGroupChatHistoryTestApi.applyRefreshPage(model, request, {
        rows: [row(inboxId)],
        hasMore: true,
        nextBeforeId: inboxId,
      });
    }

    expect(model.continuationFrontiers).toHaveLength(0);
    expect(model.scanThroughLoadedRows).toBe(true);
    expect(model.nextBeforeId).toBe(3301);
  });

  it("ignores a response from a previous session or enablement generation", () => {
    const current = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      agentOrgGroupChatHistoryTestApi.createHistoryModel(
        request.scopeKey,
        request.generation
      ),
      request,
      { rows: [row(7)], hasMore: false }
    );

    const stale = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      current,
      { scopeKey: "old-session", generation: 2 },
      { rows: [row(99)], hasMore: false }
    );

    expect(stale).toBe(current);
    expect(stale.rows.map((item) => item.inboxId)).toEqual([7]);

    const staleSameSession = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      current,
      { scopeKey: request.scopeKey, generation: 2 },
      { rows: [row(100)], hasMore: false }
    );
    expect(staleSameSession).toBe(current);
  });

  it("clears an initial failure when retry starts and accepts the retried page", () => {
    const initial = agentOrgGroupChatHistoryTestApi.createHistoryModel(
      request.scopeKey,
      request.generation
    );
    const failed = agentOrgGroupChatHistoryTestApi.applyRequestFailure(
      initial,
      request,
      "history unavailable"
    );
    expect(failed).toMatchObject({
      error: "history unavailable",
      refreshing: false,
    });

    const retrying = agentOrgGroupChatHistoryTestApi.beginRefresh(
      failed,
      request
    );
    expect(retrying).toMatchObject({ error: null, refreshing: true });

    const recovered = agentOrgGroupChatHistoryTestApi.applyRefreshPage(
      retrying,
      request,
      { rows: [row(8)], hasMore: false }
    );
    expect(recovered).toMatchObject({
      error: null,
      refreshing: false,
      rows: [expect.objectContaining({ inboxId: 8 })],
    });
  });

  it("recognizes cancelled and superseded rows as resolved pending delivery", () => {
    const rows = [
      row(10),
      row(11, { deliveryResolution: "cancelled" }),
      row(12, { deliveryResolution: "superseded" }),
    ];

    expect(
      agentOrgGroupChatHistoryTestApi.isGroupChatDeliveryResolved(10, rows)
    ).toBe(false);
    expect(
      agentOrgGroupChatHistoryTestApi.isGroupChatDeliveryResolved(11, rows)
    ).toBe(true);
    expect(
      agentOrgGroupChatHistoryTestApi.isGroupChatDeliveryResolved(12, rows)
    ).toBe(true);
    expect(
      agentOrgGroupChatHistoryTestApi.isGroupChatPendingDeliverySettled(
        10,
        {
          id: 10,
          recipientAgentId: "reviewer-agent",
          recipientMemberId: "reviewer",
          senderAgentId: "_user",
          senderMemberId: null,
          recipientName: "Reviewer",
          senderName: "User",
          displayText: "@Reviewer message-10",
          orgRunId: "run-1",
          payloadKind: "plain",
          requestId: null,
          createdAt: "2026-07-17T00:00:10Z",
          readAt: null,
          deliveryResolution: "cancelled",
        },
        rows
      )
    ).toBe(true);
  });
});
