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
});
