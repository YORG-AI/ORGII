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

import RichMarkdownEditor from ".";

const editorMocks = vi.hoisted(() => ({
  insertText: vi.fn(),
}));

vi.mock("@src/components/RichTextEditor", async () => {
  const { createElement, forwardRef, useImperativeHandle } =
    await import("react");
  return {
    default: forwardRef(function MockRichTextEditor(
      props: { editable?: boolean; matchMarkdownPreview?: boolean },
      ref
    ) {
      useImperativeHandle(ref, () => ({
        getText: () => "Hello",
        getHTML: () => "<p>Hello</p>",
        getJSON: () => undefined,
        getMarkdown: () => "**Hello**",
        setContent: () => undefined,
        clear: () => undefined,
        focus: () => undefined,
        isEmpty: () => false,
        insertImage: () => undefined,
        insertFilePill: () => undefined,
        removeFilePill: () => undefined,
        getFilePills: () => [],
        insertText: editorMocks.insertText,
        triggerAtMention: () => undefined,
        triggerSlashContext: () => undefined,
      }));
      return createElement("div", {
        "data-testid": "mock-rich-text-editor",
        "data-editable": String(props.editable),
        "data-match-markdown-preview": String(props.matchMarkdownPreview),
      });
    }),
  };
});

describe("RichMarkdownEditor", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    editorMocks.insertText.mockReset();
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

  it("renders the rich Markdown editor directly without mode controls", () => {
    act(() => {
      root.render(
        React.createElement(RichMarkdownEditor, { value: "**Hello**" })
      );
    });

    expect(
      container.querySelector("[data-rich-markdown-editor]")
    ).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(
      container
        .querySelector("[data-testid='mock-rich-text-editor']")
        ?.getAttribute("data-match-markdown-preview")
    ).toBe("true");
  });

  it("uses the rich Markdown editor for read-only content", () => {
    act(() => {
      root.render(
        React.createElement(RichMarkdownEditor, {
          value: "**Hello**",
          editable: false,
        })
      );
    });

    expect(
      container
        .querySelector("[data-testid='mock-rich-text-editor']")
        ?.getAttribute("data-editable")
    ).toBe("false");
  });

  it("forwards plain-text insertion to the rich editor selection", () => {
    const ref = React.createRef<React.ElementRef<typeof RichMarkdownEditor>>();
    act(() => {
      root.render(
        React.createElement(RichMarkdownEditor, {
          ref,
          value: "",
        })
      );
    });

    act(() => {
      ref.current?.insertText("orgii://cloud/session/ref?v=1", {
        separateFromAdjacentText: true,
      });
    });

    expect(editorMocks.insertText).toHaveBeenCalledWith(
      "orgii://cloud/session/ref?v=1",
      { separateFromAdjacentText: true }
    );
  });

  it("passes drop coordinates through to the always-visible editor", () => {
    const ref = React.createRef<React.ElementRef<typeof RichMarkdownEditor>>();
    act(() => {
      root.render(
        React.createElement(RichMarkdownEditor, {
          ref,
          value: "",
        })
      );
    });

    act(() => {
      ref.current?.insertText("orgii://cloud/session/ref?v=1", {
        separateFromAdjacentText: true,
        clientX: 123,
        clientY: 456,
      });
    });

    expect(editorMocks.insertText).toHaveBeenCalledWith(
      "orgii://cloud/session/ref?v=1",
      { separateFromAdjacentText: true, clientX: 123, clientY: 456 }
    );
  });
});
