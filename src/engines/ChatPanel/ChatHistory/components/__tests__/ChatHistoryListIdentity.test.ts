// @vitest-environment jsdom
import {
  type MutableRefObject,
  act,
  createElement,
  createRef,
  useEffect,
} from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { OptimizedChatItem } from "../../chatItemPipeline/types";
import type { GroupHeaderRenderPart } from "../../renderers/GroupHeaderRenderer";
import ChatHistoryList from "../ChatHistoryList";
import { buildChatGroupRenderKeys } from "../ChatHistoryListLayout";
import type {
  ChatHistoryListHandle,
  ChatHistoryListProps,
} from "../ChatHistoryListTypes";

const { measureElementSpy } = vi.hoisted(() => ({
  measureElementSpy: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    getItemKey: (index: number) => string | number;
  }) => {
    const items = Array.from({ length: options.count }, (_, index) => ({
      index,
      key: options.getItemKey(index),
      start: index * 360,
    }));
    return {
      getTotalSize: () => options.count * 360,
      getVirtualItems: () => items,
      measureElement: measureElementSpy,
      scrollToIndex: () => undefined,
    };
  },
}));

vi.mock("../../renderers", () => ({
  GroupItemRenderer: () => null,
}));

function bodyItem(index: number): OptimizedChatItem {
  return {
    chunk_id: `body-${index}`,
    type: "activity",
    event: { id: `event-${index}` },
  } as OptimizedChatItem;
}

describe("buildChatGroupRenderKeys", () => {
  it("keeps turn identity independent from visible body items", () => {
    expect(
      buildChatGroupRenderKeys(["turn-with-image", null, "turn-with-image"])
    ).toEqual([
      "chat-turn:turn-with-image:occurrence:0",
      "chat-group-index:1",
      "chat-turn:turn-with-image:occurrence:1",
    ]);
  });
});

describe("ChatHistoryList turn identity", () => {
  let container: HTMLDivElement;
  let root: Root;
  let imageMounts = 0;
  let imageUnmounts = 0;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const virtualListRef = createRef<ChatHistoryListHandle>();
  const virtualScrollerRef: MutableRefObject<HTMLDivElement | null> = {
    current: null,
  };
  const staticScrollerRef: MutableRefObject<HTMLDivElement | null> = {
    current: null,
  };
  const noop = () => undefined;
  const renderGroupHeader = (
    _groupIndex: number,
    renderPart: GroupHeaderRenderPart = "all"
  ) => {
    if (renderPart === "collapse") return null;
    return createElement(HeaderImage);
  };

  function HeaderImage() {
    useEffect(() => {
      imageMounts += 1;
      return () => {
        imageUnmounts += 1;
      };
    }, []);
    return createElement("img", {
      "data-testid": "appended-image",
      alt: "Attached",
      src: "data:image/png;base64,AA==",
    });
  }

  function listProps(
    flatItems: OptimizedChatItem[],
    virtualListDataKey: string
  ): ChatHistoryListProps {
    return {
      flatItems,
      groupCounts: [flatItems.length],
      turnIds: ["turn-with-image"],
      assistantCopyEventIdsByGroup: [[]],
      resolveAssistantTurnCopyContent: () => "",
      totalFlatItems: flatItems.length,
      lastAssistantFlatIndexPerItem: flatItems.map(() => null),
      codeBlockContainerWidth: 800,
      footerSpacerHeight: 0,
      bottomInset: 0,
      topPaddingPx: 0,
      planningIndicatorCount: 0,
      planningVariantIndex: 0,
      planningFooterMode: "planning",
      virtualListRef,
      virtualListDataKey,
      getIsWpGeneWorking: () => false,
      getIsExploring: () => false,
      renderGroupHeader,
      onAtBottomStateChange: noop,
      onRangeChanged: noop,
      onEndReached: noop,
      onSubmit: noop,
      onSkip: noop,
      virtualScrollerRef,
      staticScrollerRef,
    };
  }

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => undefined;
  });

  beforeEach(() => {
    imageMounts = 0;
    imageUnmounts = 0;
    measureElementSpy.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it("preserves the appended image while collapse changes the body and render mode", () => {
    const collapsedItems = [bodyItem(24)];
    const expandedItems = Array.from({ length: 25 }, (_, index) =>
      bodyItem(index)
    );

    act(() =>
      root.render(
        createElement(ChatHistoryList, listProps(collapsedItems, "collapsed"))
      )
    );
    const originalImage = container.querySelector(
      '[data-testid="appended-image"]'
    );

    act(() =>
      root.render(
        createElement(ChatHistoryList, listProps(expandedItems, "expanded"))
      )
    );
    act(() =>
      root.render(
        createElement(
          ChatHistoryList,
          listProps(collapsedItems, "collapsed-again")
        )
      )
    );

    expect(imageMounts).toBe(1);
    expect(imageUnmounts).toBe(0);
    expect(container.querySelector('[data-testid="appended-image"]')).toBe(
      originalImage
    );
    expect(measureElementSpy).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    expect(measureElementSpy.mock.calls.some(([node]) => node === null)).toBe(
      true
    );
  });
});
