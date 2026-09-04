// @vitest-environment jsdom
import React, { act, useState } from "react";
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

import MarkdownTextareaEditor from ".";
import type { MarkdownTextareaEditorRef } from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) =>
    textContent === "**hello**"
      ? React.createElement("strong", null, "hello")
      : React.createElement("span", null, textContent),
}));

describe("MarkdownTextareaEditor", () => {
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

  function renderEditor(onSubmit = vi.fn()) {
    const editorRef = React.createRef<MarkdownTextareaEditorRef>();

    function Harness() {
      const [value, setValue] = useState("hello");
      return React.createElement(MarkdownTextareaEditor, {
        ref: editorRef,
        value,
        onChange: setValue,
        onSubmit,
        dataTestId: "light-markdown",
      });
    }

    act(() => root.render(React.createElement(Harness)));
    return {
      textarea: container.querySelector("textarea") as HTMLTextAreaElement,
      editorRef,
      onSubmit,
    };
  }

  it("uses one native textarea and no contenteditable runtime", () => {
    renderEditor();

    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(container.querySelector(".ProseMirror")).toBeNull();
    expect(
      container.querySelector("[data-testid='light-markdown-toolbar']")
    ).not.toBeNull();
    expect(
      container.querySelector(
        "[data-testid='light-markdown-mode-switch'] [aria-pressed='true']"
      )?.textContent
    ).toBe("Write");
    expect(container.querySelector("[role='tablist']")).toBeNull();
    expect(
      container
        .querySelector("[data-testid='light-markdown']")
        ?.lastElementChild?.querySelector(
          "[data-testid='light-markdown-mode-switch']"
        )
    ).not.toBeNull();
  });

  it("applies toolbar formatting to the native selection", () => {
    const { textarea } = renderEditor();
    textarea.setSelectionRange(0, 5);
    const boldButton = container.querySelector(
      "[data-markdown-format='bold']"
    ) as HTMLButtonElement;

    act(() => boldButton.click());

    expect(textarea.value).toBe("**hello**");
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(7);
  });

  it("renders Markdown in Preview and restores Write mode", async () => {
    const { textarea } = renderEditor();
    textarea.setSelectionRange(0, 5);
    const boldButton = container.querySelector(
      "[data-markdown-format='bold']"
    ) as HTMLButtonElement;
    act(() => boldButton.click());

    const previewTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "[data-testid='light-markdown-mode-switch'] button"
      )
    ).find((button) => button.textContent === "Preview")!;
    await act(async () => previewTab.click());

    expect(container.querySelector("textarea")).toBeNull();
    expect(
      container.querySelector("[data-markdown-preview] strong")?.textContent
    ).toBe("hello");

    const writeTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "[data-testid='light-markdown-mode-switch'] button"
      )
    ).find((button) => button.textContent === "Write")!;
    act(() => writeTab.click());

    const restoredTextarea = container.querySelector("textarea")!;
    expect(restoredTextarea.value).toBe("**hello**");
    expect(restoredTextarea.selectionStart).toBe(2);
    expect(restoredTextarea.selectionEnd).toBe(7);
  });

  it("submits with Command or Control plus Enter", () => {
    const onSubmit = vi.fn();
    const { textarea } = renderEditor(onSubmit);

    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        })
      );
    });

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does not clip Markdown markers at the character limit", () => {
    function Harness() {
      const [value, setValue] = useState("hello");
      return React.createElement(MarkdownTextareaEditor, {
        value,
        onChange: setValue,
        maxLength: 5,
        dataTestId: "limited-markdown",
      });
    }
    act(() => root.render(React.createElement(Harness)));
    const textarea = container.querySelector("textarea")!;
    textarea.setSelectionRange(0, 5);
    const boldButton = container.querySelector(
      "[data-markdown-format='bold']"
    ) as HTMLButtonElement;

    act(() => boldButton.click());

    expect(textarea.value).toBe("hello");
  });

  it("serializes inserted file references with the shared pill grammar", () => {
    const { textarea, editorRef } = renderEditor();
    textarea.setSelectionRange(5, 5);

    act(() => {
      editorRef.current?.triggerAtMention();
      editorRef.current?.insertFilePill(
        "/repo/src/example.ts",
        false,
        "file",
        "example.ts"
      );
    });

    expect(textarea.value).toBe("hello example.ts [file:/repo/src/example.ts]");
  });

  it("closes slash before a programmatic mention opens", () => {
    const editorRef = React.createRef<MarkdownTextareaEditorRef>();
    const onAtMention = vi.fn();
    const onSlashCommand = vi.fn();
    const onSlashCommandClose = vi.fn();

    function Harness() {
      const [value, setValue] = useState("hello");
      return React.createElement(MarkdownTextareaEditor, {
        ref: editorRef,
        value,
        onChange: setValue,
        onAtMention,
        onSlashCommand,
        onSlashCommandClose,
      });
    }

    act(() => root.render(React.createElement(Harness)));
    const textarea = container.querySelector("textarea")!;
    textarea.setSelectionRange(0, 0);
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", bubbles: true })
      );
    });
    expect(onSlashCommand).toHaveBeenCalledWith("");

    act(() => editorRef.current?.triggerAtMention());

    expect(onSlashCommandClose).toHaveBeenCalledOnce();
    expect(onAtMention).toHaveBeenCalledWith("", expect.any(Object));
  });

  it("renders read-only content directly in Preview", () => {
    act(() => {
      root.render(
        React.createElement(MarkdownTextareaEditor, {
          value: "**hello**",
          onChange: vi.fn(),
          editable: false,
          dataTestId: "read-only-markdown",
        })
      );
    });

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[role='tablist']")).toBeNull();
    expect(
      container.querySelector("[data-markdown-preview] strong")?.textContent
    ).toBe("hello");
  });
});
