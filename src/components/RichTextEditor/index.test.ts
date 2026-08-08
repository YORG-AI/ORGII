// @vitest-environment jsdom
// The project test glob intentionally uses `.test.ts`; JSX is built with createElement.
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

import RichTextEditor from ".";

const mocks = vi.hoisted(() => ({
  useRichTextEditor: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tiptap/react", () => ({
  EditorContent: ({ className }: { className?: string }) =>
    createElement("div", {
      className,
      "data-testid": "rich-text-editor-content",
    }),
}));

vi.mock("./FloatingToolbar", () => ({
  FloatingToolbar: ({
    placement,
    size,
    dropdownPosition,
  }: {
    placement?: string;
    size?: string;
    dropdownPosition?: string;
  }) =>
    createElement("div", {
      role: "toolbar",
      "data-placement": placement,
      "data-size": size,
      "data-dropdown-position": dropdownPosition,
    }),
}));

vi.mock("./useRichTextEditor", () => ({
  useRichTextEditor: mocks.useRichTextEditor,
}));

describe("RichTextEditor scroll containment", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.useRichTextEditor.mockReturnValue({
      editor: {},
      isDark: false,
      showToolbar: false,
      toolbarPosition: { top: 0, left: 0 },
      getText: vi.fn(),
      getHTML: vi.fn(),
      getJSON: vi.fn(),
      getMarkdown: vi.fn(),
      setContent: vi.fn(),
      clear: vi.fn(),
      focus: vi.fn(),
      isEmpty: vi.fn(),
      insertImage: vi.fn(),
      insertFilePill: vi.fn(),
      removeFilePill: vi.fn(),
      getFilePills: vi.fn(() => []),
      insertText: vi.fn(),
      triggerAtMention: vi.fn(),
      triggerSlashContext: vi.fn(),
    });

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

  it("keeps the inline toolbar outside the constrained body scroll region", () => {
    act(() => {
      root.render(
        createElement(RichTextEditor, {
          toolbarMode: "inline",
          minHeight: 120,
          maxHeight: 360,
        })
      );
    });

    const editor = container.querySelector<HTMLElement>(".rich-text-editor");
    const toolbar = editor?.querySelector<HTMLElement>("[role='toolbar']");
    const content = editor?.querySelector<HTMLElement>(
      ".rich-text-editor-wrapper"
    );

    expect(
      editor?.classList.contains("rich-text-editor-scroll-contained")
    ).toBe(true);
    expect(editor?.style.overflowY).toBe("");
    expect(editor?.style.maxHeight).toBe("360px");
    expect(toolbar?.dataset.placement).toBe("inline");
    expect(toolbar?.nextElementSibling).toBe(content);
  });

  it("does not create a body scroll region without a maximum height", () => {
    act(() => {
      root.render(createElement(RichTextEditor, { toolbarMode: "inline" }));
    });

    expect(
      container
        .querySelector(".rich-text-editor")
        ?.classList.contains("rich-text-editor-scroll-contained")
    ).toBe(false);
  });

  it("forwards the requested toolbar control size", () => {
    act(() => {
      root.render(
        createElement(RichTextEditor, {
          toolbarMode: "inline",
          toolbarSize: "mini",
          toolbarDropdownPosition: "top-start",
        })
      );
    });

    expect(
      container.querySelector<HTMLElement>("[role='toolbar']")?.dataset.size
    ).toBe("mini");
    expect(
      container.querySelector<HTMLElement>("[role='toolbar']")?.dataset
        .dropdownPosition
    ).toBe("top-start");
  });
});
