// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeChatItem,
  makeSessionEvent,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import { useGroupHeaderRenderer } from "../useGroupHeaderRenderer";

const message = makeChatItem(
  makeSessionEvent({
    id: "user-preview",
    source: "user",
    actionType: "raw",
    functionName: "user_message",
    displayText: "A short message can exceed the old character limit. ".repeat(
      4
    ),
    displayVariant: "message",
  })
);
const headers = [message];
const interactionRef = { current: 0 };

function Header({ paginated }: { paginated: boolean }) {
  const renderHeader = useGroupHeaderRenderer({
    displaySourceGroupIndices: [0],
    sourceGroupCount: 1,
    displayGroupHeaders: headers,
    displayGroupMeta: [],
    displayGroupCount: 1,
    turnPaginationEnabled: paginated,
    tailTurnPhase: "running",
    hideUserMessage: false,
    defaultTurnCollapsed: false,
    turnCollapseInteractionAtRef: interactionRef,
    onEditSubmit: undefined,
    onRestoreCheckpoint: undefined,
  });
  return renderHeader(0);
}

describe("continuous chat user-message previews", () => {
  let container: HTMLDivElement;
  let root: Root;
  let contentHeight: number;
  let remeasure: () => void;
  const observe = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    contentHeight = 72;
    observe.mockClear();
    disconnect.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      () => contentHeight
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          remeasure = callback;
        }
        observe = observe;
        disconnect = disconnect;
      }
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(paginated = false) {
    act(() => root.render(createElement(Header, { paginated })));
  }

  function viewport(): HTMLDivElement {
    const element = container.querySelector<HTMLDivElement>(".allow-select");
    expect(element).not.toBeNull();
    return element!;
  }

  it("does not fade short rendered text even when it exceeds 120 characters", () => {
    render();

    expect(viewport().textContent).toContain(message.event?.displayText);
    expect(viewport().style.maxHeight).toBe("240px");
    expect(viewport().querySelector("button")).toBeNull();
    expect(viewport().querySelector(".bg-linear-to-t")).toBeNull();
  });

  it("leaves the full ten-line preview visible without a fade", () => {
    contentHeight = 240;
    render();

    expect(viewport().querySelector("button")).toBeNull();
    expect(viewport().querySelector(".bg-linear-to-t")).toBeNull();
  });

  it("offers expansion only after rendered content exceeds the preview", () => {
    render();
    // The same text can wrap past ten lines after narrowing the chat pane.
    contentHeight = 264;
    act(() => remeasure());

    const expand = viewport().querySelector("button");
    expect(expand).not.toBeNull();
    act(() => expand!.click());
    expect(viewport().style.maxHeight).toBe("none");
    expect(viewport().style.overflow).toBe("visible");

    act(() => viewport().querySelector("button")!.click());
    expect(viewport().style.maxHeight).toBe("240px");

    // Widening again removes both the fade and the expansion control.
    contentHeight = 72;
    act(() => remeasure());
    expect(viewport().querySelector("button")).toBeNull();
    expect(viewport().querySelector(".bg-linear-to-t")).toBeNull();
  });

  it("preserves paginated previews and disposes continuous-mode measurement", () => {
    render();
    expect(observe).toHaveBeenCalledOnce();

    render(true);
    expect(viewport().style.maxHeight).toBe("72px");
    expect(container.querySelector(".bg-linear-to-t")).not.toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();

    render();
    expect(viewport().style.maxHeight).toBe("240px");
    expect(viewport().querySelector("button")).toBeNull();
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("disconnects measurement when the message leaves the mounted list", () => {
    render();
    expect(observe).toHaveBeenCalledWith(viewport());

    act(() => root.render(null));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
