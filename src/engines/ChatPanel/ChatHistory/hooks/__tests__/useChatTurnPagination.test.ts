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
    (_, index) =>
      ({
        turnId: `turn-${index}`,
      }) as unknown as ChatGroupMeta
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

  it("keeps one hundred discovered turns directly addressable", () => {
    const result = paginate(
      Array.from({ length: 100 }, () => ({
        agentItems: 0,
        userHeader: true,
      })),
      { activePageIndex: 49 }
    );

    expect(result.pageCount).toBe(100);
    expect(result.currentPageIndex).toBe(49);
    expect(result.displayGroupHeaders).toHaveLength(1);
    expect(result.displayGroupMeta[0].turnId).toBe("turn-49");
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
