// @vitest-environment jsdom
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

import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";

import HistoryTab from "../HistoryTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@src/modules/shared/components/RichMarkdownEditor", () => ({
  default: ({
    appearance,
    dataTestId,
    matchMarkdownPreview,
    minHeight,
    showTabs,
  }: {
    appearance?: string;
    dataTestId?: string;
    matchMarkdownPreview?: boolean;
    minHeight?: number;
    showTabs?: boolean;
  }) =>
    createElement("textarea", {
      "data-testid": dataTestId,
      "data-appearance": appearance,
      "data-match-preview": String(matchMarkdownPreview),
      "data-min-height": minHeight,
      "data-show-tabs": String(showTabs),
    }),
}));

vi.mock("@src/modules/shared/components/MarkdownContent", () => ({
  MarkdownContent: ({ body }: { body: string }) =>
    createElement("div", null, body),
}));

const baseProps = {
  timelineEntries: [
    {
      id: "event-1",
      timestamp: "2026-07-27T18:23:00.000Z",
      type: WORK_ITEM_HISTORY_ACTION.COMMENTED,
      userName: "Yuki",
      userAvatar: "https://example.com/yuki.png",
      userColor: "#52c41a",
      descriptions: ["updated to-dos"],
    },
  ],
  currentUser: {
    id: "user-1",
    name: "Yuki",
    email: "yuki@example.com",
    avatar: "https://example.com/yuki.png",
    color: "#52c41a",
  },
  isSubscribed: false,
  onToggleSubscribe: vi.fn(),
  commentText: "",
  onCommentTextChange: vi.fn(),
  onCommentSubmit: vi.fn(),
  isSubmittingComment: false,
};

describe("HistoryTab activity presentation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}

        unobserve() {}

        disconnect() {}
      }
    );
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    vi.unstubAllGlobals();
  });

  const renderHistory = (presentation: "default" | "thread" = "default") => {
    act(() => {
      root.render(createElement(HistoryTab, { ...baseProps, presentation }));
    });
  };

  it("keeps thread activity collapsed by default and exposes its count", () => {
    renderHistory("thread");

    const toggle = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-thread-activity-toggle']"
    );

    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toContain("workItems.activity.title · 1");
    expect(container.textContent).not.toContain("updated to-dos");
    expect(
      container.querySelector("[data-testid='work-item-comment-composer']")
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='work-item-subscription-toggle']")
    ).not.toBeNull();
  });

  it("expands and re-collapses the compact thread activity surface", () => {
    renderHistory("thread");

    const toggle = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-thread-activity-toggle']"
    );

    act(() => toggle?.click());

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("updated to-dos");

    const composer = container.querySelector(
      "[data-testid='work-item-comment-composer']"
    );

    expect(composer).not.toBeNull();
    expect(composer?.className).toContain("flex-row items-end");
    expect(
      container
        .querySelector("[data-testid='work-item-comment-editor']")
        ?.getAttribute("data-appearance")
    ).toBe("plain");
    expect(
      container.querySelectorAll("img[src='https://example.com/yuki.png']")
    ).toHaveLength(2);

    act(() => toggle?.click());

    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("updated to-dos");
    expect(
      container.querySelector("[data-testid='work-item-comment-composer']")
    ).toBeNull();
  });

  it("keeps the full editor treatment in the default presentation", () => {
    renderHistory();

    const editor = container.querySelector(
      "[data-testid='work-item-comment-editor']"
    );

    expect(
      container.querySelector(
        "[data-testid='work-item-thread-activity-toggle']"
      )
    ).toBeNull();
    expect(container.textContent).toContain("updated to-dos");
    expect(
      container.querySelector("[data-testid='work-item-comment-composer']")
    ).toBeNull();
    expect(editor?.getAttribute("data-appearance")).toBe("outlined");
    expect(editor?.getAttribute("data-min-height")).toBe("60");
    expect(editor?.getAttribute("data-show-tabs")).toBe("true");
  });
});
