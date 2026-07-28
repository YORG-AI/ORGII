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
  MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT,
  MarkdownContent,
  TimelineCard,
  TimelineCardHeader,
  TimelineEventCard,
} from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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

  it("uses the Settings container treatment for timeline cards", () => {
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
    expect(card?.className).toContain("bg-primary-container");
    expect(card?.className).toContain("overflow-hidden");
    expect(card?.className).not.toContain("shadow-sm");
    expect(card?.lastElementChild?.getAttribute("data-testid")).toBe(
      "timeline-footer"
    );
  });

  it("uses one actor/action/timestamp header contract", () => {
    const timestamp = "2026-07-21T12:00:00Z";

    act(() => {
      root.render(
        createElement(TimelineCardHeader, {
          actor: "Ada",
          action: "commented",
          timestamp,
        })
      );
    });

    expect(container.textContent).toContain("Ada commented");
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
      timestamp
    );
  });

  it("uses the shared compact container treatment for timeline events", () => {
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
    expect(card?.className).toContain("rounded-lg");
    expect(card?.className).toContain("border-border-1");
    expect(card?.className).toContain("bg-primary-container");
    expect(card?.textContent).toContain("Event");

    const icon = card?.firstElementChild;
    expect(icon?.className).toContain("size-5");
    expect(icon?.className).not.toContain("mt-0.5");
  });
});
