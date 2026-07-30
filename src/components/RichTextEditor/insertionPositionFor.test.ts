// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEditorExtensions } from "./config";
import { insertReferenceText, insertionPositionFor } from "./useRichTextEditor";

function getMarkdown(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>)
    .markdown as { getMarkdown: () => string };
  return storage.getMarkdown();
}

/**
 * `posAtCoords` depends on real layout (getClientRects etc.) that jsdom does
 * not implement, so the drop-point resolution itself can't be exercised
 * end-to-end here. These tests cover the fallback logic and the coordinate
 * plumbing in isolation by mocking `editor.view.posAtCoords` instead — the
 * same seam `useRichTextEditor.insertText` and `insertReferenceText` go
 * through in the real app.
 */
describe("insertionPositionFor", () => {
  it("falls back to the selection end when no drop point is supplied", () => {
    const posAtCoords = vi.fn();
    const editor = { view: { posAtCoords } };

    expect(insertionPositionFor(editor, 7)).toBe(7);
    expect(insertionPositionFor(editor, 7, {})).toBe(7);
    expect(posAtCoords).not.toHaveBeenCalled();
  });

  it("falls back to the selection end when only one coordinate is present", () => {
    const posAtCoords = vi.fn();
    const editor = { view: { posAtCoords } };

    expect(insertionPositionFor(editor, 7, { clientX: 10 })).toBe(7);
    expect(insertionPositionFor(editor, 7, { clientY: 10 })).toBe(7);
    expect(posAtCoords).not.toHaveBeenCalled();
  });

  it("resolves the drop point through posAtCoords when both coordinates are given", () => {
    const posAtCoords = vi.fn().mockReturnValue({ pos: 12, inside: 12 });
    const editor = { view: { posAtCoords } };

    expect(insertionPositionFor(editor, 7, { clientX: 30, clientY: 40 })).toBe(
      12
    );
    expect(posAtCoords).toHaveBeenCalledWith({ left: 30, top: 40 });
  });

  it("falls back to the selection end when posAtCoords cannot resolve a position", () => {
    const posAtCoords = vi.fn().mockReturnValue(null);
    const editor = { view: { posAtCoords } };

    expect(
      insertionPositionFor(editor, 7, { clientX: 9999, clientY: 9999 })
    ).toBe(7);
  });
});

describe("insertReferenceText coordinate plumbing", () => {
  let editor: Editor | undefined;

  afterEach(() => editor?.destroy());

  it("inserts at the resolved drop point instead of the current caret", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "before after",
    });

    // Caret sits somewhere the drop should NOT land...
    editor.commands.setTextSelection(1);

    // ...but the pointer released over a specific spot in the document.
    const dropPos = 1 + "before ".length;
    const posAtCoords = vi
      .spyOn(editor.view, "posAtCoords")
      .mockReturnValue({ pos: dropPos, inside: dropPos });

    insertReferenceText(editor, "REF", { clientX: 123, clientY: 456 });

    expect(posAtCoords).toHaveBeenCalledWith({ left: 123, top: 456 });
    expect(getMarkdown(editor)).toBe("before REFafter");
  });

  it("falls back to the caret when posAtCoords cannot resolve the drop point", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "before after",
    });

    const caret = 1 + "before ".length;
    editor.commands.setTextSelection(caret);
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue(null);

    insertReferenceText(editor, "REF", { clientX: 9999, clientY: 9999 });

    expect(getMarkdown(editor)).toBe("before REFafter");
  });
});

it("walks the probe left when the drop point is right of a short line", () => {
  const calls: number[] = [];
  const editor = {
    view: {
      posAtCoords: ({ left }: { left: number; top: number }) => {
        calls.push(left);
        return left <= 300 ? { pos: 11, inside: 0 } : null;
      },
      dom: { getBoundingClientRect: () => ({ left: 100 }) },
    },
  };
  expect(insertionPositionFor(editor, 1, { clientX: 500, clientY: 40 })).toBe(
    11
  );
  expect(calls.length).toBeGreaterThan(1);
});

it("falls back to selection end when the walk never lands", () => {
  const editor = {
    view: {
      posAtCoords: () => null,
      dom: { getBoundingClientRect: () => ({ left: 100 }) },
    },
  };
  expect(insertionPositionFor(editor, 7, { clientX: 500, clientY: 40 })).toBe(
    7
  );
});
