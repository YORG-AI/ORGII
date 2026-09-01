// @vitest-environment jsdom
/**
 * The status trail claims the transcript's footer slot on its own.
 *
 * `ChatHistoryList` injects that slot as an extra virtual item in the last
 * group. It used to be gated on `planningIndicatorCount > 0` alone — but that
 * count drops to zero between beats and stays zero once the agent goes idle,
 * which is exactly when the trail has to hold the slot by itself. These tests
 * pin that in both render paths (virtualized and static).
 */
import { createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentStatusTrailState,
  HIDDEN_AGENT_STATUS_TRAIL_STATE,
} from "@src/engines/ChatPanel/hooks/agentStatusTrailMath";
import {
  type SmokeRoot,
  createSmokeRoot,
  settle,
} from "@src/test/reactSmokeHarness";

import type { OptimizedChatItem } from "../../chatItemPipeline/types";
import ChatHistoryList from "../ChatHistoryList";
import type {
  ChatHistoryListHandle,
  ChatHistoryListProps,
} from "../ChatHistoryListTypes";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    getItemKey: (index: number) => string | number;
  }) => ({
    getTotalSize: () => options.count * 360,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: index * 360,
      })),
    measureElement: vi.fn(),
    scrollToIndex: () => undefined,
  }),
}));

vi.mock("../../renderers", () => ({ GroupItemRenderer: () => null }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/engines/ChatPanel/components/SessionIdentityIcon", () => ({
  default: () => createElement("span", { "data-testid": "session-icon" }),
}));

const NOW_MS = 1_800_000_000_000;

function bodyItem(index: number): OptimizedChatItem {
  return {
    chunk_id: `item-${index}`,
    type: "activity",
    event: {
      id: `event-${index}`,
      sessionId: "session-test",
      source: "assistant",
      args: {},
      result: {},
    } as NonNullable<OptimizedChatItem["event"]>,
  };
}

function runningTrail(
  overrides: Partial<AgentStatusTrailState> = {}
): AgentStatusTrailState {
  return {
    phase: "running",
    startedAtMs: NOW_MS - 26_000,
    runningTasks: 0,
    isExternal: false,
    lastRefreshedAtMs: null,
    ...overrides,
  };
}

function idleTrail(): AgentStatusTrailState {
  return {
    phase: "idle",
    startedAtMs: null,
    runningTasks: 0,
    isExternal: false,
    lastRefreshedAtMs: null,
  };
}

function listProps(
  itemCount: number,
  statusTrail: AgentStatusTrailState
): ChatHistoryListProps {
  const flatItems = Array.from({ length: itemCount }, (_, i) => bodyItem(i));
  return {
    flatItems,
    groupCounts: [flatItems.length],
    turnIds: ["turn-1"],
    totalFlatItems: flatItems.length,
    codeBlockContainerWidth: 800,
    footerSpacerHeight: 0,
    bottomInset: 0,
    topPaddingPx: 0,
    // The planning line is hidden — the state this test exists for.
    planningIndicatorCount: 0,
    planningVariantIndex: 0,
    planningFooterMode: "planning",
    statusTrail,
    statusTrailSessionId: "sdeagent-1",
    virtualListRef: createRef<ChatHistoryListHandle>(),
    virtualListDataKey: `key-${itemCount}-${statusTrail.phase}`,
    getIsWpGeneWorking: () => false,
    getIsExploring: () => false,
    renderGroupHeader: () => null,
    onAtBottomStateChange: () => undefined,
    onRangeChanged: () => undefined,
    onEndReached: () => undefined,
    onSubmit: () => undefined,
    onSkip: () => undefined,
    virtualScrollerRef: { current: null },
    staticScrollerRef: { current: null },
  };
}

let smoke: SmokeRoot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
  );
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => undefined;
  smoke = createSmokeRoot();
});

afterEach(async () => {
  await smoke.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(props: ChatHistoryListProps): Promise<void> {
  await smoke.render(createElement(ChatHistoryList, props));
  await settle(0);
}

const trailNode = () =>
  smoke.container.querySelector('[data-testid="agent-status-trail"]');

describe("ChatHistoryList — status trail footer slot", () => {
  it("renders a running trail with no activity phrase (static path)", async () => {
    await mount(listProps(2, runningTrail()));

    expect(trailNode()?.getAttribute("data-trail-phase")).toBe("running");
    // The old separate planning row is gone; the phrase, when there is one,
    // is a segment on the trail itself.
    expect(
      smoke.container.querySelector('[data-testid="planning-footer"]')
    ).toBeNull();
  });

  it("renders a running trail with no activity phrase (virtualized path)", async () => {
    // Past STATIC_RENDER_ITEM_LIMIT, so the virtualized branch renders.
    await mount(listProps(30, runningTrail()));

    expect(trailNode()?.getAttribute("data-trail-phase")).toBe("running");
  });

  it("keeps the resting mark once the round ends (static path)", async () => {
    await mount(listProps(2, idleTrail()));

    expect(trailNode()?.getAttribute("data-trail-phase")).toBe("idle");
  });

  it("keeps the resting mark once the round ends (virtualized path)", async () => {
    await mount(listProps(30, idleTrail()));

    expect(trailNode()?.getAttribute("data-trail-phase")).toBe("idle");
  });

  it("claims no footer slot on a surface that hides the trail", async () => {
    // A paginated page that is not the final round: no live readout, and no
    // resting mark either — the round it would describe is not on screen.
    await mount(listProps(2, HIDDEN_AGENT_STATUS_TRAIL_STATE));

    expect(trailNode()).toBeNull();
  });
});
