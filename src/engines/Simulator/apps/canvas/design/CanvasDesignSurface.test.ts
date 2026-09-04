// @vitest-environment jsdom
import { getDefaultStore } from "jotai";
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

import { replayModeAtom } from "@src/engines/SessionCore/core/atoms";

import CanvasDesignSurface from "./CanvasDesignSurface";

const testState = vi.hoisted(() => ({
  inputAreaProps: null as Record<string, unknown> | null,
  submit: vi.fn(),
}));

vi.mock("@src/engines/ChatPanel/InputArea", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      testState.inputAreaProps = props;
      return React.createElement(
        "div",
        { "data-testid": "canvas-design-input-area" },
        props.topRowPills as React.ReactNode
      );
    },
  };
});

vi.mock(
  "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasPreviewSurface",
  async () => {
    const React = await import("react");
    return {
      default: () =>
        React.createElement(
          "button",
          {
            type: "button",
            "data-component": "Stat",
            "data-testid": "canvas-target",
          },
          "M"
        ),
    };
  }
);

vi.mock("@src/engines/ChatPanel/hooks/useWorkspaceChat", () => ({
  useWorkspaceChat: () => ({ handleSessChatSubmit: testState.submit }),
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function pointerEvent(
  type: string,
  clientX: number,
  clientY: number
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    composed: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("CanvasDesignSurface", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("CSS", {
      escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
    });
    testState.inputAreaProps = null;
    testState.submit.mockReset();
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
  });

  function renderSurface() {
    act(() =>
      root.render(
        createElement(CanvasDesignSurface, {
          payload: { mode: "html", content: "<button>M</button>" },
          reloadKey: 0,
          title: "Coffee Order Sketch",
          eventId: "event-a",
          sessionId: "session-a",
          designEnabled: true,
        })
      )
    );
  }

  it("keeps hover, portals InputArea beyond the clipped Canvas, and submits the selected context", async () => {
    renderSurface();
    const surface = container.querySelector<HTMLElement>(
      "[data-testid='canvas-design-surface']"
    )!;
    const target = container.querySelector<HTMLElement>(
      "[data-testid='canvas-target']"
    )!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 800, 600)
    );
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      rect(120, 90, 160, 80)
    );

    act(() => target.dispatchEvent(pointerEvent("pointermove", 140, 110)));
    expect(container.textContent).toContain("Stat · button");

    act(() => target.dispatchEvent(pointerEvent("pointerdown", 140, 110)));
    expect(container.textContent).toContain("Stat · button");

    act(() => window.dispatchEvent(pointerEvent("pointerup", 140, 110)));
    expect(
      document.body.querySelector("[data-testid='canvas-design-input-area']")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='canvas-design-input-area']")
    ).toBeNull();
    expect(
      document.body.querySelector("[data-canvas-design-prompt]")?.parentElement
    ).toBe(document.body);
    const prompt = document.body.querySelector<HTMLElement>(
      "[data-canvas-design-prompt]"
    );
    expect(prompt?.style.width).toBe("640px");
    expect(prompt?.className).toContain("drop-shadow-2xl");
    expect(prompt?.className).not.toContain("rounded");
    expect(prompt?.className).not.toContain("bg-bg-1");
    expect(testState.inputAreaProps).toMatchObject({
      sessionId: "session-a",
      sessionScope: "none",
      autoFocus: true,
      allowFileAttachments: false,
      enableAgentInterceptors: false,
      presentation: "contextual",
      // Interceptors are off, so session-mutating slash items (e.g. /canvas
      // creation) must be filtered out of the revision composer.
      slashItemCategories: ["skill"],
    });
    const onSubmitOverride = testState.inputAreaProps
      ?.onSubmitOverride as (input: {
      displayText: string;
    }) => Promise<boolean>;
    testState.submit.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(
        onSubmitOverride({ displayText: "字体变大一些" })
      ).rejects.toThrow("offline");
    });
    expect(
      document.body.querySelector("[data-testid='canvas-design-input-area']")
    ).not.toBeNull();

    // A parked replay cursor must snap back to follow on submit, otherwise the
    // up-to-cursor simulator window hides the incoming revision events.
    getDefaultStore().set(replayModeAtom, "replay");
    await act(async () => {
      await expect(
        onSubmitOverride({ displayText: "字体变大一些" })
      ).resolves.toBe(true);
    });
    expect(testState.submit).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining("字体变大一些"),
      expect.stringContaining('"origin": "canvas-design"')
    );
    expect(getDefaultStore().get(replayModeAtom)).toBe("follow");
    expect(
      document.body.querySelector("[data-testid='canvas-design-input-area']")
    ).toBeNull();
    expect(
      container.querySelector("[data-canvas-design-close]")
    ).not.toBeNull();

    act(() => target.dispatchEvent(pointerEvent("pointerdown", 140, 110)));
    act(() => window.dispatchEvent(pointerEvent("pointerup", 140, 110)));
    expect(
      document.body.querySelector("[data-testid='canvas-design-input-area']")
    ).not.toBeNull();

    const removeListener = vi.spyOn(surface, "removeEventListener");
    renderSurface();
    expect(
      document.body.querySelector("[data-testid='canvas-design-input-area']")
    ).not.toBeNull();
    expect(removeListener).not.toHaveBeenCalledWith(
      "pointerdown",
      expect.any(Function),
      true
    );
  });

  it("replaces the hover label with a close control after selection", () => {
    renderSurface();
    const surface = container.querySelector<HTMLElement>(
      "[data-testid='canvas-design-surface']"
    )!;
    const target = container.querySelector<HTMLElement>(
      "[data-testid='canvas-target']"
    )!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 800, 600)
    );
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      rect(120, 90, 160, 80)
    );

    act(() => target.dispatchEvent(pointerEvent("pointermove", 140, 110)));
    expect(
      container.querySelector("[data-canvas-design-hover-label]")
    ).not.toBeNull();

    act(() => target.dispatchEvent(pointerEvent("pointerdown", 140, 110)));
    act(() => window.dispatchEvent(pointerEvent("pointerup", 140, 110)));
    expect(
      container.querySelector("[data-canvas-design-hover-label]")
    ).toBeNull();
    const closeButton = container.querySelector<HTMLButtonElement>(
      "[data-canvas-design-close]"
    );
    expect(closeButton).not.toBeNull();

    act(() => closeButton?.click());
    expect(container.querySelector("[data-canvas-design-close]")).toBeNull();
    expect(
      document.body.querySelector("[data-canvas-design-prompt]")
    ).toBeNull();
  });

  it("turns the selected-element pill icon into a dismiss action on hover", () => {
    renderSurface();
    const surface = container.querySelector<HTMLElement>(
      "[data-testid='canvas-design-surface']"
    )!;
    const target = container.querySelector<HTMLElement>(
      "[data-testid='canvas-target']"
    )!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 800, 600)
    );
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      rect(120, 90, 160, 80)
    );

    act(() => target.dispatchEvent(pointerEvent("pointerdown", 140, 110)));
    act(() => window.dispatchEvent(pointerEvent("pointerup", 140, 110)));

    const selectionPill = document.body.querySelector<HTMLElement>(
      "[data-canvas-design-selection-pill]"
    );
    expect(selectionPill).not.toBeNull();
    expect(
      selectionPill?.querySelector('[data-icon="mouse-pointer-2"]')
    ).not.toBeNull();

    act(() =>
      selectionPill?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      )
    );
    expect(selectionPill?.querySelector('[data-icon="x"]')).not.toBeNull();

    act(() => selectionPill?.click());
    expect(
      document.body.querySelector("[data-canvas-design-prompt]")
    ).toBeNull();
    expect(container.querySelector("[data-canvas-design-close]")).toBeNull();
  });

  it("docks the shared InputArea above the floating replay controls for a full-surface selection", () => {
    renderSurface();
    const surface = container.querySelector<HTMLElement>(
      "[data-testid='canvas-design-surface']"
    )!;
    const target = container.querySelector<HTMLElement>(
      "[data-testid='canvas-target']"
    )!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      rect(40, 50, 800, 600)
    );
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      rect(40, 50, 800, 600)
    );

    act(() => target.dispatchEvent(pointerEvent("pointerdown", 140, 110)));
    act(() => window.dispatchEvent(pointerEvent("pointerup", 140, 110)));

    const prompt = document.body.querySelector<HTMLElement>(
      "[data-canvas-design-prompt]"
    );
    expect(prompt?.dataset.placement).toBe("docked");
    expect(prompt?.style.position).toBe("fixed");
    expect(prompt?.style.bottom).not.toBe("");
    expect(Number.parseFloat(prompt?.style.bottom ?? "0")).toBe(
      window.innerHeight - 650 + 72
    );
    expect(prompt?.style.top).toBe("");
  });

  it("keeps the compact prompt below the selection when one row fits", () => {
    renderSurface();
    const surface = container.querySelector<HTMLElement>(
      "[data-testid='canvas-design-surface']"
    )!;
    const target = container.querySelector<HTMLElement>(
      "[data-testid='canvas-target']"
    )!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 800, 400)
    );
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      rect(100, 230, 160, 30)
    );

    act(() => target.dispatchEvent(pointerEvent("pointerdown", 140, 240)));
    act(() => window.dispatchEvent(pointerEvent("pointerup", 140, 240)));

    const prompt = document.body.querySelector<HTMLElement>(
      "[data-canvas-design-prompt]"
    );
    expect(prompt?.dataset.placement).toBe("below");
    expect(prompt?.style.top).toBe("272px");
    expect(prompt?.style.bottom).toBe("");
  });

  it("docks a tall outer element instead of flipping the prompt above the Canvas", () => {
    renderSurface();
    const surface = container.querySelector<HTMLElement>(
      "[data-testid='canvas-design-surface']"
    )!;
    const target = container.querySelector<HTMLElement>(
      "[data-testid='canvas-target']"
    )!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      rect(80, 200, 900, 900)
    );
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      rect(120, 400, 820, 400)
    );

    act(() => target.dispatchEvent(pointerEvent("pointerdown", 140, 420)));
    act(() => window.dispatchEvent(pointerEvent("pointerup", 140, 420)));

    const prompt = document.body.querySelector<HTMLElement>(
      "[data-canvas-design-prompt]"
    );
    expect(prompt?.dataset.placement).toBe("docked");
    expect(prompt?.style.bottom).not.toBe("");
    expect(prompt?.style.top).toBe("");
  });
});
