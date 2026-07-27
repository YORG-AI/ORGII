// @vitest-environment jsdom
import { StrictMode, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type SmokeRoot,
  createSmokeRoot,
  settle,
} from "@src/test/reactSmokeHarness";

import type { UseChatTurnPaginationReturn } from "./useChatTurnPagination";
import { useVisibleExternalReplayTurnMetadata } from "./useVisibleExternalReplayTurnMetadata";

const mocks = vi.hoisted(() => ({
  generation: "generation-1" as string | null,
  loadTurnIndex: vi.fn(),
  sourceId: "codex_app",
}));

vi.mock("@src/api/tauri/externalHistory/replay", () => ({
  resolveExternalReplayTarget: (sessionId: string) => ({
    sessionId,
    sourceId: mocks.sourceId,
  }),
}));

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  loadTurnIndex: mocks.loadTurnIndex,
}));

vi.mock(
  "@src/engines/SessionCore/sync/externalReplayTurnState",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@src/engines/SessionCore/sync/externalReplayTurnState")
      >();
    return {
      ...actual,
      getExternalReplayTurnGeneration: () => mocks.generation,
    };
  }
);

function pagesFor(
  ...turnIndices: number[]
): UseChatTurnPaginationReturn["pages"] {
  return turnIndices.map((turnIndex) => ({
    startGroupIndex: 0,
    endGroupIndex: -1,
    flatStartIndex: 0,
    flatEndIndex: 0,
    replayBodyLoaded: false,
    replayTurnSummary: {
      turnId: `__external_replay_turn_index__:${turnIndex}`,
      renderedUserEventId: null,
      nextTurnId: null,
      turnIndex,
      startedAt: "2026-07-26T00:00:00.000Z",
      endedAt: null,
      durationMs: null,
      userPreview: "",
      eventCount: 1,
      bodyEventCount: 1,
    },
  }));
}

function pageWithProviderHeader(
  turnIndex: number
): UseChatTurnPaginationReturn["pages"][number] {
  return {
    ...pagesFor(turnIndex)[0],
    replayTurnSummary: {
      ...pagesFor(turnIndex)[0].replayTurnSummary!,
      turnId: `provider-turn-${turnIndex}`,
      userPreview: "",
    },
  };
}

function projectedTurn(turnIndex: number, userPreview: string) {
  return {
    turnId: `__external_replay_turn_index__:${turnIndex}`,
    nextTurnId: null,
    startedAt: "2026-07-26T00:00:00.000Z",
    endedAt: null,
    durationMs: null,
    userPreview,
    eventCount: 1,
    bodyEventCount: 1,
  };
}

function MetadataProbe({
  pages,
  visiblePageIndices = pages.map((_, index) => index),
}: {
  pages: UseChatTurnPaginationReturn["pages"];
  visiblePageIndices?: number[];
}) {
  const summaries = useVisibleExternalReplayTurnMetadata({
    sessionId: "codexapp-fixture",
    pages,
    visiblePageIndices,
  });
  return createElement("div", {
    "data-previews": JSON.stringify(
      [...summaries.entries()].map(([turnIndex, summary]) => [
        turnIndex,
        summary.userPreview,
      ])
    ),
  });
}

async function settleMetadataRetries(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await settle(300);
  }
}

describe("useVisibleExternalReplayTurnMetadata", () => {
  let root: SmokeRoot;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.generation = "generation-1";
    mocks.sourceId = "codex_app";
    mocks.loadTurnIndex.mockReset();
    root = createSmokeRoot();
  });

  afterEach(async () => {
    await root.unmount();
    vi.useRealTimers();
  });

  it("bounds retries when compact metadata returns no matching rows", async () => {
    mocks.loadTurnIndex.mockResolvedValue([]);
    await root.render(createElement(MetadataProbe, { pages: pagesFor(0) }));

    await settleMetadataRetries();
    expect(mocks.loadTurnIndex).toHaveBeenCalledTimes(3);
    await settleMetadataRetries();
    expect(mocks.loadTurnIndex).toHaveBeenCalledTimes(3);
  });

  it("retries transient failures and publishes the recovered preview", async () => {
    mocks.loadTurnIndex
      .mockRejectedValueOnce(new Error("busy"))
      .mockRejectedValueOnce(new Error("busy again"))
      .mockResolvedValueOnce([projectedTurn(0, "Recovered title")]);
    await root.render(
      createElement(
        StrictMode,
        null,
        createElement(MetadataProbe, { pages: pagesFor(0) })
      )
    );

    await settleMetadataRetries();
    expect(mocks.loadTurnIndex).toHaveBeenCalledTimes(3);
    expect(
      root.container.firstElementChild?.getAttribute("data-previews")
    ).toBe('[[0,"Recovered title"]]');
  });

  it("does not exhaust missing retries when virtual scrolling cancels requests", async () => {
    const pages = pagesFor(0, 1, 2, 3);
    const pending: Array<{
      turnIds: string[];
      resolve: (turns: ReturnType<typeof projectedTurn>[]) => void;
    }> = [];
    mocks.loadTurnIndex.mockImplementation(
      (_sessionId: string, turnIds: string[]) =>
        new Promise((resolve) => {
          pending.push({ turnIds, resolve });
        })
    );
    const targetId = "__external_replay_turn_index__:0";
    const targetRequests = () =>
      pending.filter(({ turnIds }) => turnIds.includes(targetId));

    await root.render(
      createElement(MetadataProbe, {
        pages,
        visiblePageIndices: [0],
      })
    );
    expect(targetRequests()).toHaveLength(1);

    for (const extraVisibleIndex of [1, 2, 3]) {
      const currentTargetRequest = targetRequests().at(-1);
      expect(currentTargetRequest).toBeDefined();
      await root.render(
        createElement(MetadataProbe, {
          pages,
          visiblePageIndices: [0, extraVisibleIndex],
        })
      );
      currentTargetRequest?.resolve([]);
      await settle(300);
    }

    expect(targetRequests()).toHaveLength(4);
    targetRequests()
      .at(-1)
      ?.resolve([projectedTurn(0, "Stable title")]);
    await settle();

    expect(
      root.container.firstElementChild?.getAttribute("data-previews")
    ).toContain('[0,"Stable title"]');
  });

  it("invalidates cached previews when the replay generation changes", async () => {
    mocks.loadTurnIndex.mockResolvedValueOnce([projectedTurn(0, "Old title")]);
    const pages = pagesFor(0);
    await root.render(createElement(MetadataProbe, { pages }));
    await settle();
    expect(
      root.container.firstElementChild?.getAttribute("data-previews")
    ).toBe('[[0,"Old title"]]');

    mocks.generation = "generation-2";
    mocks.loadTurnIndex.mockResolvedValueOnce([projectedTurn(0, "New title")]);
    await root.render(createElement(MetadataProbe, { pages }));
    await settle();

    expect(
      root.container.firstElementChild?.getAttribute("data-previews")
    ).toBe('[[0,"New title"]]');
  });

  it.each(["cursor_ide", "windsurf"])(
    "loads compact %s previews without waiting for a turn body",
    async (sourceId) => {
      mocks.sourceId = sourceId;
      mocks.loadTurnIndex.mockResolvedValueOnce([
        projectedTurn(0, `${sourceId} compact prompt`),
      ]);
      await root.render(createElement(MetadataProbe, { pages: pagesFor(0) }));
      await settle();

      expect(mocks.loadTurnIndex).toHaveBeenCalledTimes(1);
      expect(mocks.loadTurnIndex).toHaveBeenCalledWith("codexapp-fixture", [
        "__external_replay_turn_index__:0",
      ]);
      expect(
        root.container.firstElementChild?.getAttribute("data-previews")
      ).toBe(`[[0,"${sourceId} compact prompt"]]`);
    }
  );

  it("loads compact metadata when a provider header has no user preview", async () => {
    mocks.loadTurnIndex.mockResolvedValueOnce([
      projectedTurn(7, "Provider turn title"),
    ]);

    await root.render(
      createElement(MetadataProbe, {
        pages: [pageWithProviderHeader(7)],
      })
    );
    await settle();

    expect(mocks.loadTurnIndex).toHaveBeenCalledWith("codexapp-fixture", [
      "__external_replay_turn_index__:7",
    ]);
    expect(
      root.container.firstElementChild?.getAttribute("data-previews")
    ).toBe('[[7,"Provider turn title"]]');
  });
});
