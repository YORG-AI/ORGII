// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpotlightItemList } from "@src/scaffold/GlobalSpotlight/components/SpotlightItemList";
import type { SpotlightItem } from "@src/scaffold/GlobalSpotlight/types";

import { BranchDropdownList } from "../BranchDropdownList";
import { installVirtualListTestLayout } from "./virtualListTestLayout";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let container: HTMLDivElement;
let restoreLayout: () => void;
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  restoreLayout = installVirtualListTestLayout();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restoreLayout();
  delete environment.IS_REACT_ACT_ENVIRONMENT;
});

describe("shared picker virtualization", () => {
  it("bounds 10,000 mixed Spotlight rows, scrolls to an unmounted selection, and resets after filtering", async () => {
    const items: SpotlightItem[] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        id: String(index),
        label: `Row ${index}`,
        icon: "",
        type: "option",
        desc:
          index === 0 || index % 3 === 1 ? "Two-line PR metadata" : undefined,
        data: index === 0 ? { isHeader: true } : undefined,
      })
    );
    const onItemSelect = vi.fn();
    const props = {
      items,
      selectedIndex: 1,
      onItemSelect,
      onItemHover: vi.fn(),
      searchQuery: "",
      fixedHeight: true,
      containerHeight: 350,
    };
    await act(async () => root.render(createElement(SpotlightItemList, props)));
    expect(
      container.querySelectorAll("[data-spotlight-item-index]").length
    ).toBeLessThan(25);
    expect(
      container.querySelector('[data-spotlight-item-id="9999"]')
    ).toBeNull();
    // Header = 34; a two-line option = 48 + 3 gap, followed by a 34 + 3 option.
    expect(
      (
        container.querySelector('[data-spotlight-item-index="2"]')
          ?.parentElement as HTMLElement
      ).style.top
    ).toBe("85px");
    await act(async () =>
      root.render(
        createElement(SpotlightItemList, { ...props, selectedIndex: 9999 })
      )
    );
    const last = container.querySelector<HTMLElement>(
      '[data-spotlight-item-id="9999"]'
    );
    expect(last).not.toBeNull();
    expect(
      container.querySelectorAll("[data-spotlight-item-index]").length
    ).toBeLessThan(25);
    await act(async () => last!.click());
    expect(onItemSelect).toHaveBeenCalledWith(items[9999]);
    await act(async () =>
      root.render(
        createElement(SpotlightItemList, {
          ...props,
          items: [items[9999]],
          selectedIndex: 0,
          searchQuery: "9999",
        })
      )
    );
    expect(container.textContent).toContain("Row 9999");
    expect(
      container.querySelectorAll("[data-spotlight-item-index]")
    ).toHaveLength(1);
    expect(container.firstElementChild?.scrollTop).toBe(0);
    await act(async () =>
      root.render(
        createElement(SpotlightItemList, {
          ...props,
          items: [],
          selectedIndex: -1,
          searchQuery: "missing",
        })
      )
    );
    expect(
      container.querySelectorAll("[data-spotlight-item-index]")
    ).toHaveLength(0);
    expect((container.firstElementChild as HTMLElement).style.height).toBe(
      "350px"
    );
  });

  it("bounds dropdown rows and loads only on scrolling near the end, without an append loop", async () => {
    const items = Array.from({ length: 500 }, (_, index) => index);
    const onLoadMore = vi.fn();
    const onSelect = vi.fn();
    const props = {
      items,
      getKey: (item: number) => item,
      estimateHeight: () => 48,
      renderItem: (item: number) =>
        createElement(
          "button",
          { className: "min-h-12", onClick: () => onSelect(item) },
          String(item)
        ),
      selectedIndex: -1,
      keyboardNavigated: false,
      searchQuery: "",
      onLoadMore,
    };
    await act(async () =>
      root.render(createElement(BranchDropdownList<number>, props))
    );
    expect(container.querySelectorAll("button").length).toBeLessThan(25);
    expect(onLoadMore).not.toHaveBeenCalled();
    const scroller = container.firstElementChild as HTMLElement;
    await act(async () => {
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    const last = [...container.querySelectorAll("button")].find(
      (row) => row.textContent === "499"
    );
    expect(last).toBeDefined();
    await act(async () => last!.click());
    expect(onSelect).toHaveBeenCalledWith(499);
    await act(async () =>
      root.render(
        createElement(BranchDropdownList<number>, {
          ...props,
          items: [...items, 500],
        })
      )
    );
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.render(
        createElement(BranchDropdownList<number>, {
          ...props,
          items: [499],
          selectedIndex: 0,
          keyboardNavigated: true,
          searchQuery: "499",
        })
      )
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(scroller.scrollTop).toBe(0);
  });
});
