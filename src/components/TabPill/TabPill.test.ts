// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
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

import TabPill from ".";

function getButtonTag(markup: string, testId: string): string {
  const match = markup.match(
    new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`)
  );

  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("TabPill", () => {
  let container: HTMLDivElement;
  let root: Root;
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

  it("paints pill selection and hover states on each button without a measured overlay", () => {
    const markup = renderToStaticMarkup(
      createElement(TabPill, {
        variant: "pill",
        appearance: "ghost",
        activeTab: "list",
        tabs: [
          { key: "list", label: "List", dataTestId: "list-tab" },
          { key: "board", label: "Board", dataTestId: "board-tab" },
        ],
      })
    );

    expect(getButtonTag(markup, "list-tab")).toContain("bg-surface-hover");
    expect(getButtonTag(markup, "board-tab")).toContain(
      "hover:bg-surface-hover"
    );
    expect(markup).not.toContain("data-seg");
    expect(markup).not.toContain("translateX(");
  });

  it("keeps exactly one uncontrolled tab active after selection", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        createElement(TabPill, {
          variant: "pill",
          defaultActiveTab: "list",
          onChange,
          tabs: [
            { key: "list", label: "List", dataTestId: "list-tab" },
            { key: "board", label: "Board", dataTestId: "board-tab" },
          ],
        })
      );
    });

    const boardTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="board-tab"]'
    );
    act(() => boardTab?.click());

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("board");
    expect(
      container.querySelectorAll<HTMLButtonElement>('[data-active="true"]')
    ).toHaveLength(1);
    expect(boardTab?.dataset.active).toBe("true");
  });
});
