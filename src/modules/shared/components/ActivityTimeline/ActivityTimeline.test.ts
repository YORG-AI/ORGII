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

import {
  ActivityHeaderActionButton,
  ActivityTimestamp,
  ConnectedTimelineItem,
  MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT,
  MarkdownContent,
  TimelineCard,
  TimelineCardHeader,
  TimelineCopyButton,
  TimelineEventCard,
  TimelineLoadingSkeleton,
} from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en" },
  }),
}));

vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) => textContent,
}));

let contentHeight = 0;

class ImmediateResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(): void {
    this.callback([], this);
  }

  disconnect(): void {}

  unobserve(): void {}
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("activity timeline", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollHeightDescriptor: PropertyDescriptor | undefined;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    contentHeight = 0;
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    container.remove();
    vi.unstubAllGlobals();
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollHeight",
        scrollHeightDescriptor
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders short Markdown without an expand control", () => {
    contentHeight = 120;

    act(() => {
      root.render(createElement(MarkdownContent, { body: "Short body" }));
    });

    const viewport = container.querySelector<HTMLElement>(".group\\/expand");
    expect(viewport?.style.maxHeight).toBe(
      `${MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT}px`
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("uses the configurable chat body typography token for Markdown", () => {
    contentHeight = 120;

    act(() => {
      root.render(createElement(MarkdownContent, { body: "Body text" }));
    });

    const body = container.querySelector<HTMLElement>(".chat-text");
    expect(body).not.toBeNull();
    expect(body?.className).toContain("text-text-1");
    expect(body?.className).not.toContain("text-[12px]");
    expect(body?.className).not.toContain("leading-5");
  });

  it("keeps the complete rendered Markdown tree selectable", () => {
    contentHeight = 120;

    act(() => {
      root.render(
        createElement(MarkdownContent, {
          body: "Paragraph with **nested emphasis**.",
        })
      );
    });

    const body = container.querySelector<HTMLElement>(".chat-text");
    expect(body?.className).toContain("allow-select-deep");
  });

  it("collapses long Markdown with an always-visible shared control", () => {
    contentHeight = 600;

    act(() => {
      root.render(createElement(MarkdownContent, { body: "Long body" }));
    });

    const viewport = container.querySelector<HTMLElement>(".group\\/expand");
    const expandButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="actions.expand"]'
    );

    expect(viewport?.style.maxHeight).toBe(
      `${MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT}px`
    );
    expect(expandButton).not.toBeNull();
    expect(expandButton?.parentElement?.className).toContain("opacity-100");
    expect(expandButton?.parentElement?.className).not.toContain("opacity-0");
    expect(
      container.querySelector<HTMLElement>(".pointer-events-none")?.className
    ).toContain("from-primary-container");

    act(() => {
      expandButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(viewport?.style.maxHeight).toBe("none");
    expect(
      container.querySelector('button[aria-label="actions.collapse"]')
    ).not.toBeNull();
  });

  it("supports matching the preview fade to its surrounding surface", () => {
    contentHeight = 600;

    act(() => {
      root.render(
        createElement(MarkdownContent, {
          body: "Long body",
          fadeFrom: "from-chat-pane",
        })
      );
    });

    expect(
      container.querySelector<HTMLElement>(".pointer-events-none")?.className
    ).toContain("from-chat-pane");
  });

  it("renders timeline loading as a text-free accessible skeleton", () => {
    act(() => {
      root.render(
        createElement(TimelineLoadingSkeleton, {
          label: "Loading activity…",
        })
      );
    });

    const skeleton = container.querySelector<HTMLElement>(
      "[data-testid='timeline-loading-skeleton']"
    );
    expect(skeleton?.getAttribute("role")).toBe("status");
    expect(skeleton?.getAttribute("aria-label")).toBe("Loading activity…");
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
    expect(skeleton?.textContent).toBe("");
    expect(skeleton?.className).toContain("animate-pulse");
    expect(skeleton?.querySelectorAll("[aria-hidden='true']")).toHaveLength(6);
  });

  it("matches the timeline body to the page and fills only the header", () => {
    act(() => {
      root.render(
        createElement(
          TimelineCard,
          {
            header: createElement("span", null, "Header"),
            footer: createElement(
              "div",
              { "data-testid": "timeline-footer" },
              "Footer"
            ),
          },
          createElement("span", null, "Body")
        )
      );
    });

    const card = container.firstElementChild;
    expect(card?.className).toContain("rounded-xl");
    expect(card?.className).toContain("border-border-1");
    expect(card?.className).toContain("bg-chat-pane");
    expect(card?.className).not.toContain("bg-primary-container");
    expect(card?.className).toContain("overflow-hidden");
    expect(card?.className).not.toContain("shadow-xs");
    expect(card?.firstElementChild?.className).toContain(
      "bg-primary-container"
    );
    expect(card?.firstElementChild?.className).toContain("allow-select-deep");
    expect(card?.children.item(1)?.className).toContain("allow-select-deep");
    expect(card?.lastElementChild?.getAttribute("data-testid")).toBe(
      "timeline-footer"
    );
  });

  it("connects through the full height of a multi-line timeline event", () => {
    act(() => {
      root.render(
        createElement(
          ConnectedTimelineItem,
          null,
          createElement(
            TimelineEventCard,
            { icon: createElement("span", null, "I") },
            createElement(
              "span",
              null,
              "First line",
              createElement("br"),
              "Second line"
            )
          )
        )
      );
    });

    const connector = container.querySelector<HTMLElement>(
      '[data-testid="timeline-connector"]'
    );
    expect(connector?.className).toContain("absolute");
    expect(connector?.className).toContain("top-5");
    expect(connector?.className).toContain("bottom-0");
    expect(connector?.nextElementSibling?.className).toContain("z-10");
  });

  it("can expose a bounded semantic stop to an owning scroll trail", () => {
    act(() => {
      root.render(
        createElement(
          ConnectedTimelineItem,
          { trailLabel: `Issue update ${"x".repeat(140)}` },
          createElement("span", null, "Update")
        )
      );
    });

    const item = container.firstElementChild;
    expect(item?.hasAttribute("data-scroll-trail-target")).toBe(true);
    expect(item?.getAttribute("data-scroll-trail-label")).toHaveLength(120);
  });

  it("uses one actor/action/timestamp header contract", () => {
    const timestamp = "2026-07-21T12:00:00Z";

    act(() => {
      root.render(
        createElement(TimelineCardHeader, {
          actor: "Ada",
          action: "commented",
          timestamp,
          timestampLabel: "20:00",
        })
      );
    });

    expect(container.textContent).toContain("Ada commented");
    const time = container.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe(timestamp);
    expect(time?.textContent).toBe("20:00");
    expect(time?.getAttribute("title")).not.toBe(timestamp);
  });

  it("omits the year from current-year activity timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T12:00:00Z"));

    act(() => {
      root.render(
        createElement(ActivityTimestamp, {
          timestamp: "2026-06-24T15:32:00Z",
        })
      );
    });

    const time = container.querySelector("time");
    expect(time?.textContent).not.toContain("2026");
    expect(time?.getAttribute("title")).toContain("2026");
  });

  it("retains the year for activity from an earlier year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T12:00:00Z"));

    act(() => {
      root.render(
        createElement(ActivityTimestamp, {
          timestamp: "2025-06-24T15:32:00Z",
        })
      );
    });

    expect(container.querySelector("time")?.textContent).toContain("2025");
  });

  it("uses one icon-only action contract for activity headers", () => {
    act(() => {
      root.render(
        createElement(ActivityHeaderActionButton, {
          icon: createElement("span", null, "Icon"),
          label: "Edit",
        })
      );
    });

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Edit");
    expect(button?.title).toBe("Edit");
    expect(button?.className).toContain("text-text-3");
    expect(button?.className).toContain("hover:bg-fill-2");
  });

  it("builds timeline copy on the canonical action with the copy icon", () => {
    act(() => {
      root.render(createElement(TimelineCopyButton, { body: "Copy me" }));
    });

    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='timeline-copy-button']"
    );
    expect(button?.getAttribute("aria-label")).toBe("actions.copy");
    expect(button?.className).toContain("hover:bg-fill-2");
    expect(button?.querySelector('[data-icon="copy"]')).not.toBeNull();
    expect(button?.querySelector('[data-icon="clipboard"]')).toBeNull();
  });

  it("uses a smaller compact row with vertically centered content", () => {
    act(() => {
      root.render(
        createElement(
          TimelineEventCard,
          { icon: createElement("span", null, "Icon") },
          "Event"
        )
      );
    });

    const card = container.firstElementChild;
    expect(card?.className).not.toContain("rounded-lg");
    expect(card?.className).not.toContain("border-border-1");
    expect(card?.className).not.toContain("bg-primary-container");
    expect(card?.className).toContain("items-center");
    expect(card?.className).toContain("text-[11px]");
    expect(card?.className).toContain("px-2.5");
    expect(card?.className).not.toContain("py-2");
    expect(card?.textContent).toContain("Event");

    const icon = card?.firstElementChild;
    expect(icon?.className).toContain("size-5");
    expect(icon?.className).toContain("rounded-full");
    expect(icon?.className).toContain("bg-fill-2");
    expect(icon?.className).not.toContain("mt-0.5");

    const content = card?.lastElementChild;
    expect(content?.className).toContain("leading-4");
  });
});
