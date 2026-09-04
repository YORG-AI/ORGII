// @vitest-environment jsdom
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

import DropdownCollapsibleSectionHeader from "./DropdownCollapsibleSectionHeader";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("DropdownCollapsibleSectionHeader", () => {
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

  it("renders the chevron after the title and exposes expanded state", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          DropdownCollapsibleSectionHeader,
          {
            expanded: true,
            onToggle: vi.fn(),
          } as unknown as React.ComponentProps<
            typeof DropdownCollapsibleSectionHeader
          >,
          "Workspace · 4"
        )
      );
    });

    const button = container.querySelector("button");
    const title = button?.querySelector("span");
    const chevron = button?.querySelector('[data-icon="chevron-right"]');

    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(title?.textContent).toBe("Workspace · 4");
    expect(title?.className).not.toContain("flex-1");
    expect(chevron?.classList.contains("rotate-90")).toBe(true);
    expect(title?.compareDocumentPosition(chevron as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("invokes the toggle from the full section-title button", async () => {
    const onToggle = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(
          DropdownCollapsibleSectionHeader,
          {
            expanded: false,
            onToggle,
          } as unknown as React.ComponentProps<
            typeof DropdownCollapsibleSectionHeader
          >,
          "External · 13"
        )
      );
    });

    const button = container.querySelector<HTMLButtonElement>("button");
    act(() => button?.click());

    expect(onToggle).toHaveBeenCalledOnce();
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(
      button
        ?.querySelector('[data-icon="chevron-right"]')
        ?.classList.contains("rotate-90")
    ).toBe(false);
  });
});
