// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
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
  guideHighlightAtom,
  showGuideHighlightAtom,
} from "@src/store/ui/guideHighlightAtom";

import GuideHighlightOverlay from "../GuideHighlightOverlay";

vi.mock("framer-motion", async () => {
  const ReactModule = await import("react");
  type MotionDivProps = React.HTMLAttributes<HTMLDivElement> & {
    initial?: unknown;
    animate?: unknown;
    exit?: unknown;
    transition?: unknown;
  };
  const MotionDiv = ReactModule.forwardRef<HTMLDivElement, MotionDivProps>(
    ({ initial, animate, exit, transition, ...props }, ref) => {
      void initial;
      void animate;
      void exit;
      void transition;
      return ReactModule.createElement("div", { ...props, ref });
    }
  );
  MotionDiv.displayName = "MotionDiv";
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: MotionDiv },
  };
});

vi.mock("@src/components/Button", () => ({
  default: ({ onClick }: { onClick?: () => void }) =>
    React.createElement("button", { type: "button", onClick }, "close"),
}));

vi.mock("@src/components/Glass/config", () => ({
  getMaterialConfig: () => ({ blur: 12, background: "white" }),
}));

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ isDark: false }),
}));

vi.mock("@src/util/ui/window/viewport", () => ({
  getViewportSize: () => ({ width: 1200, height: 800 }),
}));

class MockMutationObserver {
  static instances: MockMutationObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: MutationCallback) {
    MockMutationObserver.instances.push(this);
  }

  trigger(): void {
    this.callback([], this as unknown as MutationObserver);
  }
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("GuideHighlightOverlay delayed targets", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    MockMutationObserver.instances = [];
    vi.stubGlobal(
      "MutationObserver",
      MockMutationObserver as unknown as typeof MutationObserver
    );
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
      window.clearTimeout(handle)
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document
      .querySelectorAll('[data-guide-target="delayed.target"]')
      .forEach((node) => node.remove());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("waits for navigation content, then scrolls to and highlights it", async () => {
    const store = createStore();
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(GuideHighlightOverlay)
        )
      );
    });

    act(() => {
      store.set(showGuideHighlightAtom, {
        targetId: "delayed.target",
        title: "Invite a teammate",
        message: "Create an invite link here.",
      });
      vi.advanceTimersByTime(1);
    });

    const observer = MockMutationObserver.instances[0];
    expect(observer).toBeDefined();
    expect(observer.observe).toHaveBeenCalledWith(document.body, {
      childList: true,
      subtree: true,
    });
    expect(document.body.textContent).not.toContain(
      "Create an invite link here."
    );

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(observer.disconnect).toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const resumedObserver = MockMutationObserver.instances[1];
    expect(resumedObserver).toBeDefined();
    expect(resumedObserver.observe).toHaveBeenCalledOnce();

    const target = document.createElement("button");
    target.dataset.guideTarget = "delayed.target";
    target.scrollIntoView = vi.fn();
    target.getBoundingClientRect = () =>
      ({
        top: 200,
        left: 300,
        width: 140,
        height: 40,
        right: 440,
        bottom: 240,
        x: 300,
        y: 200,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(target);

    await act(async () => {
      resumedObserver.trigger();
      vi.advanceTimersByTime(1);
    });

    expect(document.body.textContent).toContain("Create an invite link here.");
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "center",
      behavior: "smooth",
    });
    expect(resumedObserver.disconnect).toHaveBeenCalled();
    expect(store.get(guideHighlightAtom)?.targetId).toBe("delayed.target");
  });
});
