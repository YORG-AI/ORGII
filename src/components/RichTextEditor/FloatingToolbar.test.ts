// @vitest-environment jsdom
// The project test glob intentionally uses `.test.ts`; JSX is built with createElement.
import type { Editor } from "@tiptap/react";
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

import { FloatingToolbar } from "./FloatingToolbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("FloatingToolbar", () => {
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

  it("renders the formatting controls inline without a floating position", () => {
    const editor = {
      isActive: vi.fn(() => false),
    } as unknown as Editor;

    act(() => {
      root.render(
        createElement(FloatingToolbar, {
          editor,
          placement: "inline",
        })
      );
    });

    const toolbar = container.querySelector<HTMLElement>("[role='toolbar']");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.classList.contains("rich-text-editor-toolbar-inline")).toBe(
      true
    );
    expect(toolbar?.style.position).toBe("");
    expect(
      toolbar?.querySelector("[aria-label='creator.toolbar.bold']")
    ).not.toBeNull();
  });

  it("applies the mini control size when requested", () => {
    const editor = {
      isActive: vi.fn(() => false),
    } as unknown as Editor;

    act(() => {
      root.render(
        createElement(FloatingToolbar, {
          editor,
          placement: "inline",
          size: "mini",
        })
      );
    });

    expect(
      container
        .querySelector("[role='toolbar']")
        ?.classList.contains("rich-text-editor-toolbar-mini")
    ).toBe(true);
  });

  it("uses compact 14px controls without visual separators", () => {
    const editor = {
      isActive: vi.fn(() => false),
    } as unknown as Editor;

    act(() => {
      root.render(
        createElement(FloatingToolbar, {
          editor,
          placement: "inline",
          size: "mini",
        })
      );
    });

    const toolbar = container.querySelector<HTMLElement>("[role='toolbar']");
    expect(toolbar?.querySelector(".toolbar-divider")).toBeNull();
    expect(
      toolbar
        ?.querySelector("[aria-label='creator.toolbar.bold'] svg")
        ?.getAttribute("width")
    ).toBe("14");
    expect(
      toolbar
        ?.querySelector("[aria-label='creator.toolbar.lists'] svg")
        ?.getAttribute("width")
    ).toBe("14");
  });

  it("opens formatting choices in the shared dropdown panel", async () => {
    const run = vi.fn();
    const chain = {
      focus: vi.fn(() => chain),
      setParagraph: vi.fn(() => chain),
      run,
    };
    const editor = {
      isActive: vi.fn(() => false),
      chain: vi.fn(() => chain),
    } as unknown as Editor;

    act(() => {
      root.render(
        createElement(FloatingToolbar, {
          editor,
          placement: "inline",
          dropdownPosition: "top-start",
        })
      );
    });

    const headingTrigger = container.querySelector<HTMLButtonElement>(
      "[aria-label='creator.toolbar.normalText']"
    );
    await act(async () => {
      headingTrigger?.click();
      await Promise.resolve();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });

    expect(headingTrigger?.getAttribute("aria-expanded")).toBe("true");
    const listbox = document.querySelector<HTMLElement>(
      "[role='listbox'][aria-label='creator.toolbar.normalText']"
    );
    expect(listbox).not.toBeNull();
    expect(listbox?.classList.contains("rounded-lg")).toBe(true);
    const paragraphOption = listbox?.querySelector<HTMLElement>(
      "[role='option'][aria-selected='true']"
    );
    expect(paragraphOption).not.toBeNull();
    expect(listbox?.parentElement?.style.zIndex).toBe("99999");

    await act(async () => {
      paragraphOption?.click();
      await Promise.resolve();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
    });

    expect(chain.setParagraph).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(headingTrigger?.getAttribute("aria-expanded")).toBe("false");
  });
});
