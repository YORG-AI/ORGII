// @vitest-environment jsdom
//
// Guards the virtualizer against the width refit: rows are now rendered inside
// the shared `DETAIL_PANEL_TOKENS.contentMaxWidth` column instead of spanning
// the pane, so every node handed to `measureElement` must sit INSIDE that
// column. If a later change hoists the virtual container out of the column,
// `measureElement` would start reporting pane-width heights and every row would
// be mis-sized — that regression is what this file catches.
import { act, createElement } from "react";
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

import type { LocalChannelMessage } from "@src/store/ui/localChannelMessagesAtom";

import ChannelMessageList, {
  CHANNEL_VIRTUALIZATION_THRESHOLD,
} from "./ChannelMessageList";

const mocks = vi.hoisted(() => ({
  measureElement: vi.fn(),
  scrollToIndex: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    getVirtualItems: () =>
      Array.from({ length: Math.min(5, count) }, (_, index) => ({
        key: index,
        index,
        start: index * 64,
        end: (index + 1) * 64,
        size: 64,
        lane: 0,
      })),
    measureElement: mocks.measureElement,
    scrollToIndex: mocks.scrollToIndex,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) =>
    createElement("div", { "data-testid": "markdown" }, textContent),
}));

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function makeMessages(count: number): LocalChannelMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    channelId: "chan-1",
    body: `message ${index}`,
    createdAt: "2026-07-31T00:00:00.000Z",
    editedAt: null,
    deletedAt: null,
  }));
}

describe("ChannelMessageList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function render(messages: readonly LocalChannelMessage[]) {
    act(() => {
      root.render(
        createElement(ChannelMessageList, {
          messages,
          authorLabel: "You",
          onEdit: null,
          onDelete: null,
        })
      );
    });
  }

  function column(): HTMLElement | null {
    return container.querySelector<HTMLElement>(".max-w-\\[900px\\]");
  }

  it("puts the transcript column inside the scroller, centred at the shared width", () => {
    render(makeMessages(3));

    const scroller = container.querySelector<HTMLElement>(
      "[data-testid='channel-message-list']"
    );
    const inner = column();
    expect(inner).not.toBeNull();
    expect(inner?.parentElement).toBe(scroller);
    expect(scroller?.className).toContain("allow-select-deep");
    expect(inner?.className).toContain("mx-auto");
    // Bottom inset clears the absolutely positioned composer footer.
    expect(inner?.className).toContain("pb-36");
  });

  it("measures virtual rows inside the constrained column, not the full pane", () => {
    render(makeMessages(CHANNEL_VIRTUALIZATION_THRESHOLD + 10));

    const measured = mocks.measureElement.mock.calls
      .map(([node]) => node as HTMLElement | null)
      .filter((node): node is HTMLElement => node instanceof HTMLElement);
    expect(measured.length).toBeGreaterThan(0);

    const inner = column();
    for (const node of measured) {
      expect(node.dataset.index).toBeDefined();
      expect(inner?.contains(node)).toBe(true);
    }
  });

  it("renders plainly below the virtualization threshold", () => {
    render(makeMessages(3));

    expect(mocks.measureElement).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-index]")).toHaveLength(0);
    expect(
      container.querySelectorAll("[data-testid='channel-message']")
    ).toHaveLength(3);
  });
});
