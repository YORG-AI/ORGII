// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
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

import NavigationMenu from ".";
import type { NavigationMenuItem } from "../config";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/router/lazy/preload", () => ({
  preloadRouteByPath: vi.fn(),
}));

const items: NavigationMenuItem[] = [
  {
    id: "work-items",
    key: "work-items",
    label: "Work Items",
    children: [
      {
        id: "github-prs",
        key: "github-prs",
        label: "GitHub PRs",
      },
    ],
  },
];

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("NavigationMenu selected-child expansion", () => {
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
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps automatic expansion internal when a child is selected", async () => {
    const onSubmenuOpenChange = vi.fn();

    await act(async () => {
      root.render(
        createElement(NavigationMenu, {
          items,
          selectedKeys: ["github-prs"],
          onMenuItemClick: vi.fn(),
          onSubmenuOpenChange,
        })
      );
    });

    expect(
      container.querySelector('[data-menu-item-id="github-prs"]')
    ).not.toBeNull();
    expect(onSubmenuOpenChange).not.toHaveBeenCalled();
  });

  it("reports an explicit parent-row toggle", async () => {
    const onSubmenuOpenChange = vi.fn();

    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(NavigationMenu, {
            items,
            selectedKeys: [],
            onMenuItemClick: vi.fn(),
            onSubmenuOpenChange,
          })
        )
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-menu-item-id="work-items"]')
        ?.click();
    });

    expect(onSubmenuOpenChange).toHaveBeenCalledOnce();
    expect(onSubmenuOpenChange).toHaveBeenCalledWith("work-items", true);
  });
});
