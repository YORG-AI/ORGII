// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
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

import PersistentDetailTabPanel, {
  type PersistentDetailTabPanelProps,
} from "./PersistentDetailTabPanel";

describe("PersistentDetailTabPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  it("mounts on first visit and stays mounted while hidden", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();

    function StatefulContent() {
      useEffect(() => {
        mounted();
        return () => {
          unmounted();
        };
      }, []);
      return createElement("input", { defaultValue: "preserved" });
    }

    const render = (active: boolean) =>
      act(() => {
        root.render(
          createElement(
            PersistentDetailTabPanel,
            {
              active,
              id: "detail-tabpanel-list",
              ariaLabelledBy: "detail-tab-list",
            } as PersistentDetailTabPanelProps,
            createElement(StatefulContent)
          )
        );
      });

    render(false);
    expect(container.querySelector("input")).toBeNull();

    render(true);
    const input = container.querySelector<HTMLInputElement>("input");
    const panel = container.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(input).not.toBeNull();
    input!.value = "edited";
    panel!.scrollTop = 72;

    render(false);
    expect(
      container.querySelector<HTMLElement>('[role="tabpanel"]')?.style.display
    ).toBe("none");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe(
      "edited"
    );
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();

    render(true);
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe(
      "edited"
    );
    expect(
      container.querySelector<HTMLElement>('[role="tabpanel"]')?.scrollTop
    ).toBe(72);
    expect(mounted).toHaveBeenCalledTimes(1);
  });
});

describe("PersistentDetailTabPanel layout", () => {
  it("stacks its content vertically so width-indefinite children survive", () => {
    // `display: flex` without a direction made the panel a row, collapsing any
    // child that carries no width of its own — `DetailPanelContainer` gates its
    // content behind an `@[300px]` container query, so a zero-width panel
    // rendered a completely blank pane while sibling tabs looked fine.
    const markup = renderToStaticMarkup(
      createElement(
        PersistentDetailTabPanel,
        {
          active: true,
          id: "panel",
          ariaLabelledBy: "tab",
        } as PersistentDetailTabPanelProps,
        createElement("span", null, "content")
      )
    );

    expect(markup).toContain("flex-col");
    expect(markup).toContain("content");
  });
});
