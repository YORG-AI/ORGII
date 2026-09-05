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

import Checkbox from "@src/components/Checkbox";

import Table from ".";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("Table row interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("lets checkbox chrome toggle without invoking the row action", () => {
    const onCheckboxChange = vi.fn();
    const onRowClick = vi.fn();

    act(() => {
      root.render(
        createElement(Table<{ id: string }>, {
          columns: [
            {
              key: "selection",
              render: () =>
                createElement(Checkbox, {
                  ariaLabel: "Select row 1",
                  onCheckedChange: onCheckboxChange,
                }),
            },
          ],
          data: [{ id: "row-1" }],
          pagination: false,
          showHeader: false,
          onRowClick,
        })
      );
    });

    const checkboxIcon = container.querySelector<HTMLElement>(
      "[data-checkbox-icon]"
    );
    expect(checkboxIcon).not.toBeNull();

    act(() => checkboxIcon?.click());

    expect(onCheckboxChange).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>("[data-checkbox-input]")
        ?.checked
    ).toBe(true);

    const checkedIcon = container.querySelector("[data-checkbox-icon] svg");
    expect(checkedIcon).not.toBeNull();

    act(() => {
      checkedIcon?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });

    expect(onCheckboxChange).toHaveBeenCalledTimes(2);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>("[data-checkbox-input]")
        ?.checked
    ).toBe(false);
  });

  it("uses right and down chevrons for collapsed and expanded settings rows", () => {
    act(() => {
      root.render(
        createElement(Table<{ id: string }>, {
          columns: [{ key: "id", dataIndex: "id" }],
          data: [{ id: "row-1" }],
          rowKey: "id",
          pagination: false,
          showHeader: false,
          settings: true,
          expandable: {
            expandedRowRender: () => createElement("div", null, "Details"),
          },
        })
      );
    });

    const expandButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand row"]'
    );
    expect(expandButton).not.toBeNull();
    expect(
      expandButton?.querySelector('[data-icon="chevron-right"]')
    ).not.toBeNull();

    act(() => expandButton?.click());

    const collapseButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse row"]'
    );
    expect(collapseButton).not.toBeNull();
    expect(
      collapseButton?.querySelector('[data-icon="chevron-down"]')
    ).not.toBeNull();
  });

  it("toggles a settings row from non-interactive content when a row callback is present", () => {
    const onRowClick = vi.fn();
    const onActionClick = vi.fn();

    act(() => {
      root.render(
        createElement(Table<{ id: string }>, {
          columns: [
            {
              key: "name",
              render: () => createElement("span", null, "Row 1"),
            },
            {
              key: "action",
              render: () =>
                createElement(
                  "button",
                  { type: "button", onClick: onActionClick },
                  "Action"
                ),
            },
          ],
          data: [{ id: "row-1" }],
          rowKey: "id",
          pagination: false,
          showHeader: false,
          settings: true,
          onRowClick,
          expandable: {
            expandedRowRender: () => createElement("div", null, "Details"),
          },
        })
      );
    });

    const rowLabel = Array.from(container.querySelectorAll("span")).find(
      (element) => element.textContent === "Row 1"
    );
    const actionButton = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === "Action"
    );

    act(() => rowLabel?.click());

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('button[aria-label="Collapse row"]')
    ).not.toBeNull();

    act(() => actionButton?.click());

    expect(onActionClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('button[aria-label="Collapse row"]')
    ).not.toBeNull();

    act(() => rowLabel?.click());

    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('button[aria-label="Expand row"]')
    ).not.toBeNull();
  });
});
