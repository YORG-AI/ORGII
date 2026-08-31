// @vitest-environment jsdom
import { type FC, type ReactNode, act, createElement } from "react";
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

import EventBlockHeader from "./EventBlockHeader";
import { EventBlockHeaderTitle } from "./EventBlockHeaderTextSlots";
import type { EventBlockHeaderProps } from "./types";

type TestHeaderProps = Omit<EventBlockHeaderProps, "children"> & {
  children?: ReactNode;
};
const TestEventBlockHeader = EventBlockHeader as FC<TestHeaderProps>;

describe("EventBlockHeader text selection", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("keeps title text selectable without making the whole header selectable", () => {
    act(() => {
      root.render(
        createElement(
          TestEventBlockHeader,
          { isCollapsed: false },
          createElement(EventBlockHeaderTitle, null, "Thought")
        )
      );
    });

    const header = container.firstElementChild;
    const title = container.querySelector("span");
    expect(header?.classList.contains("select-none")).toBe(false);
    expect(title?.classList.contains("select-text")).toBe(true);
  });

  it("does not toggle the header after dragging across its title", () => {
    const onClick = vi.fn();
    const selection = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ isCollapsed: false } as Selection);

    act(() => {
      root.render(
        createElement(
          TestEventBlockHeader,
          { isCollapsed: false, onClick },
          createElement(EventBlockHeaderTitle, null, "Thought")
        )
      );
    });

    act(() => {
      container.firstElementChild?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });
    expect(onClick).not.toHaveBeenCalled();

    selection.mockReturnValue({ isCollapsed: true } as Selection);
    act(() => {
      container.firstElementChild?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });
    expect(onClick).toHaveBeenCalledOnce();
  });
});
