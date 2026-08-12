// @vitest-environment jsdom
import React, { act, createElement, createRef } from "react";
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

import ScrollTrail, {
  ScrollTrailTarget,
  getScrollTrailMarkerWidthClass,
  normalizeScrollTrailLabel,
  resolveActiveScrollTrailIndex,
  sampleScrollTrailIndices,
} from "./ScrollTrail";

vi.mock("react-i18next", () => {
  const t = (
    _key: string,
    options?: Record<string, string | number | undefined>
  ) =>
    String(options?.defaultValue ?? "")
      .replace("{{label}}", String(options?.label ?? ""))
      .replace("{{current}}", String(options?.current ?? ""))
      .replace("{{total}}", String(options?.total ?? ""));
  return { useTranslation: () => ({ t }) };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("ScrollTrail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let animationFrames: FrameRequestCallback[];
  let resizeObservers: TestResizeObserver[];
  let mutationObservers: TestMutationObserver[];
  let scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  let contentRef: React.RefObject<HTMLDivElement | null>;
  let scrollContainerClientHeight: number;
  let scrollContainerScrollHeight: number;

  class TestResizeObserver implements ResizeObserver {
    readonly disconnect = vi.fn();
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();

    constructor(readonly callback: ResizeObserverCallback) {
      resizeObservers.push(this);
    }
  }

  class TestMutationObserver implements MutationObserver {
    readonly disconnect = vi.fn();
    readonly observe = vi.fn();
    readonly takeRecords = vi.fn(() => []);

    constructor(readonly callback: MutationCallback) {
      mutationObservers.push(this);
    }
  }

  function flushAnimationFrames(): void {
    const callbacks = animationFrames.splice(0);
    callbacks.forEach((callback) => callback(0));
  }

  function Harness({ alignment }: { alignment?: "center" | "start" }) {
    return createElement(
      "div",
      null,
      createElement(
        "div",
        { ref: scrollContainerRef, "data-testid": "trail-scroll-container" },
        createElement(
          "div",
          { ref: contentRef },
          createElement(
            ScrollTrailTarget,
            { label: "Description" },
            "Description"
          ),
          createElement(ScrollTrailTarget, { label: "Activity" }, "Activity"),
          createElement(
            ScrollTrailTarget,
            { label: "Discussion" },
            "Discussion"
          )
        )
      ),
      createElement(ScrollTrail, {
        scrollContainerRef,
        contentRef,
        ariaLabel: "Work item navigation",
        alignment,
        testId: "work-item-trail",
      })
    );
  }

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    animationFrames = [];
    resizeObservers = [];
    mutationObservers = [];
    scrollContainerRef = createRef<HTMLDivElement>();
    contentRef = createRef<HTMLDivElement>();
    scrollContainerClientHeight = 200;
    scrollContainerScrollHeight = 1_000;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("MutationObserver", TestMutationObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", () => ({ matches: false }));

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRectMock(this: HTMLElement) {
        const label = this.getAttribute("data-scroll-trail-label");
        const topByLabel: Record<string, number> = {
          Description: 20,
          Activity: 400,
          Discussion: 900,
        };
        const top = label ? (topByLabel[label] ?? 0) : 0;
        return {
          bottom: top,
          height: 0,
          left: 0,
          right: 0,
          top,
          width: 0,
          x: 0,
          y: top,
          toJSON: () => undefined,
        };
      }
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(function scrollToMock(
        this: HTMLElement,
        options?: ScrollToOptions | number,
        y?: number
      ) {
        this.scrollTop =
          typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
      }),
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "trail-scroll-container"
          ? scrollContainerClientHeight
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "trail-scroll-container"
          ? scrollContainerScrollHeight
          : 0;
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders semantic markers, navigates, coalesces scroll work, and disposes observers", () => {
    act(() => root.render(createElement(Harness, {})));
    act(flushAnimationFrames);

    const trail = container.querySelector<HTMLElement>(
      '[data-testid="work-item-trail"]'
    );
    const buttons = trail?.querySelectorAll("button") ?? [];
    expect(trail?.getAttribute("aria-label")).toBe("Work item navigation");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute("aria-current")).toBe("step");

    act(() => buttons[1].click());
    const scrollContainer = container.querySelector<HTMLElement>(
      '[data-testid="trail-scroll-container"]'
    );
    expect(scrollContainer?.scrollTop).toBe(388);

    const scheduledBeforeScroll = animationFrames.length;
    act(() => {
      scrollContainer?.dispatchEvent(new Event("scroll"));
      scrollContainer?.dispatchEvent(new Event("scroll"));
    });
    expect(animationFrames).toHaveLength(scheduledBeforeScroll + 1);

    if (scrollContainer) scrollContainer.scrollTop = 800;
    act(flushAnimationFrames);
    expect(buttons[2].getAttribute("aria-current")).toBe("step");

    act(() => root.unmount());
    expect(resizeObservers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(mutationObservers[0]?.disconnect).toHaveBeenCalledOnce();
    const scheduledAfterUnmount = animationFrames.length;
    scrollContainer?.dispatchEvent(new Event("scroll"));
    expect(animationFrames).toHaveLength(scheduledAfterUnmount);

    root = createRoot(container);
  });

  it("stays visible when the shell does not report overflow", () => {
    scrollContainerClientHeight = 1_000;
    scrollContainerScrollHeight = 1_000;

    act(() => root.render(createElement(Harness, {})));
    act(flushAnimationFrames);

    const trail = container.querySelector<HTMLElement>(
      '[data-testid="work-item-trail"]'
    );
    expect(trail?.querySelectorAll("button")).toHaveLength(3);
    expect(trail?.classList.contains("hidden")).toBe(false);
  });

  it("can begin directly beneath a preceding floating surface", () => {
    act(() => root.render(createElement(Harness, { alignment: "start" })));
    act(flushAnimationFrames);

    const trail = container.querySelector<HTMLElement>(
      '[data-testid="work-item-trail"]'
    );
    expect(trail?.className).toContain("top-2");
    expect(trail?.className).not.toContain("top-1/2");
    expect(trail?.className).not.toContain("-translate-y-1/2");
  });

  it("keeps a visible root marker when no semantic stops exist", () => {
    function SparseHarness(): React.ReactNode {
      return createElement(
        "div",
        null,
        createElement(
          "div",
          {
            ref: scrollContainerRef,
            "data-testid": "trail-scroll-container",
          },
          createElement("div", { ref: contentRef }, "Loading")
        ),
        createElement(ScrollTrail, {
          scrollContainerRef,
          contentRef,
          ariaLabel: "Work item navigation",
          placement: "rail",
          testId: "work-item-trail",
        })
      );
    }

    act(() => root.render(createElement(SparseHarness)));
    act(flushAnimationFrames);

    const trail = container.querySelector<HTMLElement>(
      '[data-testid="work-item-trail"]'
    );
    expect(trail?.querySelectorAll("button")).toHaveLength(1);
    expect(trail?.className).toContain("left-1/2");
    expect(trail?.classList.contains("hidden")).toBe(false);
  });
});

describe("ScrollTrail helpers", () => {
  it("samples long surfaces evenly while retaining both ends", () => {
    const indices = sampleScrollTrailIndices(101, 20);

    expect(indices).toHaveLength(20);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(100);
    expect(new Set(indices).size).toBe(20);
  });

  it("uses the final marker at the bottom and the nearest preceding marker elsewhere", () => {
    expect(
      resolveActiveScrollTrailIndex({
        markerOffsets: [20, 400, 900],
        scrollTop: 800,
        clientHeight: 200,
        scrollHeight: 1_000,
      })
    ).toBe(2);
    expect(
      resolveActiveScrollTrailIndex({
        markerOffsets: [20, 400, 900],
        scrollTop: 375,
        clientHeight: 200,
        scrollHeight: 1_000,
      })
    ).toBe(1);
  });

  it("fans nearby handles and bounds normalized labels", () => {
    expect(
      Array.from({ length: 7 }, (_, index) =>
        getScrollTrailMarkerWidthClass(index, 3)
      )
    ).toEqual(["w-2", "w-3", "w-4", "w-5", "w-4", "w-3", "w-2"]);
    expect(normalizeScrollTrailLabel(`  ${"a".repeat(140)}  `)).toHaveLength(
      120
    );
  });
});
