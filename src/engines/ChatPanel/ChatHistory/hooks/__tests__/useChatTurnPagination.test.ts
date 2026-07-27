/**
 * useChatTurnPagination — page construction tests.
 *
 * Focus: `mergeUserOnlyPages` (used by subagent cells via
 * `hideGroupUserMessage`) must fold user-only turn groups into adjacent
 * contentful pages so the "Latest Round" page is never structurally
 * blank. Regression coverage for the "subagent cell stuck on a blank
 * frame" bug (2026-06-11): queued user messages flushed into a dead
 * subagent session created trailing user-only groups, each of which got
 * its own page; with user-message cards hidden those pages rendered as
 * empty frames.
 *
 * Runs in the node environment by mocking React's useMemo as a
 * pass-through (same pattern as useChatGroups.test.ts).
 */
import { describe, expect, it, vi } from "vitest";

import type { ExternalReplayTurnSummary } from "@src/api/tauri/externalHistory";

import type { OptimizedChatItem } from "../../chatItemPipeline/types";
import type { ChatGroupMeta } from "../useChatGroups";
import { useChatTurnPagination } from "../useChatTurnPagination";

vi.mock("react", () => ({
  useMemo: <Value>(factory: () => Value) => factory(),
}));

let counter = 0;

function fakeItem(): OptimizedChatItem {
  counter++;
  return { chunk_id: `item-${counter}`, type: "activity" } as OptimizedChatItem;
}

function fakeHeader(): OptimizedChatItem {
  counter++;
  return { chunk_id: `header-${counter}`, type: "user" } as OptimizedChatItem;
}

/**
 * Build pagination inputs from a compact spec: each entry is a turn group
 * with `agentItems` agent-side items and whether it has a user header.
 */
function paginate(
  groups: Array<{ agentItems: number; userHeader: boolean }>,
  options: { mergeUserOnlyPages?: boolean; activePageIndex?: number } = {}
) {
  const groupCounts = groups.map((group) => group.agentItems);
  const groupHeaders = groups.map((group) =>
    group.userHeader ? fakeHeader() : null
  );
  const groupMeta = groups.map(
    () => ({ turnId: null }) as unknown as ChatGroupMeta
  );
  const flatItems = groups.flatMap((group) =>
    Array.from({ length: group.agentItems }, fakeItem)
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- useMemo is mocked as a pass-through; this is not a real hook call
  return useChatTurnPagination({
    enabled: true,
    activePageIndex: options.activePageIndex ?? 999,
    groupCounts,
    groupHeaders,
    groupMeta,
    flatItems,
    lastAssistantFlatIndexPerItem: flatItems.map(() => null),
    mergeUserOnlyPages: options.mergeUserOnlyPages ?? false,
  });
}

describe("useChatTurnPagination — default paging", () => {
  it("gives each user-headed group its own page", () => {
    const result = paginate([
      { agentItems: 3, userHeader: true },
      { agentItems: 2, userHeader: true },
      { agentItems: 0, userHeader: true },
    ]);

    expect(result.pageCount).toBe(3);
    // Last page is the user-only group — blank agent content.
    expect(result.displayFlatItems).toHaveLength(0);
  });
});

describe("useChatTurnPagination — mergeUserOnlyPages", () => {
  it("folds trailing user-only groups into the last contentful page", () => {
    const result = paginate(
      [
        { agentItems: 3, userHeader: true },
        { agentItems: 2, userHeader: true },
        // Dead-session tail: queued user messages, no agent output.
        { agentItems: 0, userHeader: true },
        { agentItems: 0, userHeader: true },
      ],
      { mergeUserOnlyPages: true }
    );

    expect(result.pageCount).toBe(2);
    // Latest page = second contentful turn + the dead tail groups.
    expect(result.currentPageIndex).toBe(1);
    expect(result.displayFlatItems).toHaveLength(2);
    expect(result.pages[1].endGroupIndex).toBe(3);
  });

  it("folds leading user-only groups into the next contentful page", () => {
    const result = paginate(
      [
        { agentItems: 0, userHeader: true },
        { agentItems: 4, userHeader: true },
      ],
      { mergeUserOnlyPages: true }
    );

    expect(result.pageCount).toBe(1);
    expect(result.displayFlatItems).toHaveLength(4);
  });

  it("produces a single page when no group has agent items", () => {
    const result = paginate(
      [
        { agentItems: 0, userHeader: true },
        { agentItems: 0, userHeader: true },
      ],
      { mergeUserOnlyPages: true }
    );

    expect(result.pageCount).toBe(1);
    expect(result.pages[0].startGroupIndex).toBe(0);
    expect(result.pages[0].endGroupIndex).toBe(1);
  });

  it("returns no pages for an empty session", () => {
    const result = paginate([], { mergeUserOnlyPages: true });
    expect(result.pageCount).toBe(0);
  });

  it("keeps per-turn paging for contentful turns", () => {
    const result = paginate(
      [
        { agentItems: 2, userHeader: true },
        { agentItems: 3, userHeader: true },
        { agentItems: 1, userHeader: true },
      ],
      { mergeUserOnlyPages: true, activePageIndex: 1 }
    );

    expect(result.pageCount).toBe(3);
    expect(result.displayFlatItems).toHaveLength(3);
  });
});

describe("useChatTurnPagination — bounded external replay", () => {
  it("maps the complete provider-stable user event id to its loaded group", () => {
    const stableId = "cursoride-user-provider-stable-id";
    const header = {
      ...fakeHeader(),
      event: { id: stableId },
    } as OptimizedChatItem;
    const summary: ExternalReplayTurnSummary = {
      turnId: stableId,
      renderedUserEventId: stableId,
      nextTurnId: null,
      turnIndex: 0,
      startedAt: "2026-07-22T00:00:00Z",
      endedAt: null,
      durationMs: null,
      userPreview: "prompt",
      eventCount: 2,
      bodyEventCount: 1,
    };

    // eslint-disable-next-line react-hooks/rules-of-hooks -- useMemo is mocked as a pass-through; this is not a real hook call
    const result = useChatTurnPagination({
      enabled: true,
      activePageIndex: 0,
      groupCounts: [1],
      groupHeaders: [header],
      groupMeta: [{ turnId: stableId } as ChatGroupMeta],
      flatItems: [fakeItem()],
      lastAssistantFlatIndexPerItem: [null],
      externalReplayTurnSummaries: [summary],
    });

    expect(result.pages[0]?.startGroupIndex).toBe(0);
    expect(result.pages[0]?.replayBodyLoaded).toBe(true);
    expect(result.pages[0]?.replayTurnSummary?.turnId).toBe(stableId);
  });

  it("maps a Codex turn locator to its distinct rendered user event id", () => {
    const latestHeader = {
      ...fakeHeader(),
      event: { id: "codex-user-19372" },
    } as OptimizedChatItem;
    const olderHeader = {
      ...fakeHeader(),
      event: { id: "codex-user-19216" },
    } as OptimizedChatItem;
    const summaries: ExternalReplayTurnSummary[] = [
      {
        turnId: "codex-turn-163",
        renderedUserEventId: "codex-user-19216",
        nextTurnId: "codex-turn-164",
        turnIndex: 163,
        startedAt: "2026-07-22T08:01:00Z",
        endedAt: "2026-07-22T08:40:00Z",
        durationMs: 39 * 60 * 1000,
        userPreview: "older prompt",
        eventCount: 3,
        bodyEventCount: 2,
      },
      {
        turnId: "codex-turn-164",
        renderedUserEventId: "codex-user-19372",
        nextTurnId: null,
        turnIndex: 164,
        startedAt: "2026-07-22T08:40:00Z",
        endedAt: null,
        durationMs: null,
        userPreview: "latest prompt",
        eventCount: 2,
        bodyEventCount: 1,
      },
    ];

    // eslint-disable-next-line react-hooks/rules-of-hooks -- useMemo is mocked as a pass-through; this is not a real hook call
    const result = useChatTurnPagination({
      enabled: true,
      activePageIndex: 0,
      groupCounts: [2, 1],
      groupHeaders: [olderHeader, latestHeader],
      groupMeta: [
        { turnId: "codex-user-19216" } as ChatGroupMeta,
        { turnId: "codex-user-19372" } as ChatGroupMeta,
      ],
      flatItems: [fakeItem(), fakeItem(), fakeItem()],
      lastAssistantFlatIndexPerItem: [1, 1, 2],
      externalReplayTurnSummaries: summaries,
    });

    expect(result.pages[0]?.startGroupIndex).toBe(0);
    expect(result.pages[0]?.replayBodyLoaded).toBe(true);
    expect(result.displayFlatItems).toHaveLength(2);
  });

  it("renders no unrelated body while an external turn is still unloaded", () => {
    const latestHeader = {
      ...fakeHeader(),
      event: { id: "codex-user-19372" },
    } as OptimizedChatItem;
    const summary: ExternalReplayTurnSummary = {
      turnId: "codex-turn-0",
      renderedUserEventId: null,
      nextTurnId: "codex-turn-1",
      turnIndex: 0,
      startedAt: "2026-07-12T00:00:00Z",
      endedAt: "2026-07-12T00:01:00Z",
      durationMs: 60_000,
      userPreview: "oldest prompt",
      eventCount: 4,
      bodyEventCount: 3,
    };

    // eslint-disable-next-line react-hooks/rules-of-hooks -- useMemo is mocked as a pass-through; this is not a real hook call
    const result = useChatTurnPagination({
      enabled: true,
      activePageIndex: 0,
      groupCounts: [1],
      groupHeaders: [latestHeader],
      groupMeta: [{ turnId: "codex-user-19372" } as ChatGroupMeta],
      flatItems: [fakeItem()],
      lastAssistantFlatIndexPerItem: [0],
      externalReplayTurnSummaries: [summary],
    });

    expect(result.pages[0]?.replayBodyLoaded).toBe(false);
    expect(result.displayGroupHeaders).toEqual([]);
    expect(result.displayFlatItems).toEqual([]);
  });
});
