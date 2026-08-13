// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createEditorExtensions } from "./config";
import { insertReferenceText } from "./useRichTextEditor";

function getMarkdown(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>)
    .markdown as { getMarkdown: () => string };
  return storage.getMarkdown();
}

describe("RichTextEditor markdown persistence", () => {
  let editor: Editor | undefined;

  afterEach(() => editor?.destroy());

  it("loads stored markdown as rich content and serializes formatting back", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: [
        "## Delivery plan",
        "",
        "Use **rich text** with `inline code`.",
        "",
        "- First item",
        "- Second item",
      ].join("\n"),
    });

    expect(editor.getHTML()).toContain("<h2>Delivery plan</h2>");
    expect(editor.getHTML()).toContain("<strong>rich text</strong>");
    expect(editor.getHTML()).toContain("<code>inline code</code>");
    expect(editor.getHTML()).toContain("<ul");

    const markdown = getMarkdown(editor);
    expect(markdown).toContain("## Delivery plan");
    expect(markdown).toContain("**rich text**");
    expect(markdown).toContain("`inline code`");
    expect(markdown).toContain("- First item");
  });

  it("round-trips task lists used by the floating toolbar", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "- [ ] Pending\n- [x] Complete",
    });

    expect(editor.getHTML()).toContain('data-type="taskList"');
    expect(getMarkdown(editor)).toContain("- [ ] Pending");
    expect(getMarkdown(editor)).toContain("- [x] Complete");
  });

  it("renders inserted images with lazy asynchronous decoding", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "",
    });

    editor.commands.setImage({ src: "asset://example/animation.gif" });

    expect(editor.getHTML()).toContain('loading="lazy"');
    expect(editor.getHTML()).toContain('decoding="async"');
  });

  it("keeps file-pill metadata in the saved document", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "Related file: ",
    });

    editor.commands.insertFilePill({
      filePath: "/repo/src/example.ts",
      fileName: "example.ts",
      iconType: "file",
    });

    const markdown = getMarkdown(editor);
    expect(markdown).toContain("example.ts");
    expect(markdown).toContain("/repo/src/example.ts");
  });

  it("inserts URI text without HTML-escaping query separators", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "",
    });
    const reference =
      "orgii://cloud/session/ref?v=1&org=org-id&owner=owner-id&session=session-id";

    editor.commands.insertContent({
      type: "text",
      text: reference,
    });

    expect(getMarkdown(editor)).toBe(reference);
    expect(getMarkdown(editor)).not.toContain("&amp;");
  });
});

describe("insertReferenceText", () => {
  let editor: Editor | undefined;

  afterEach(() => editor?.destroy());

  it("never replaces an active range selection — it lands after it", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "keep DROPME end",
    });

    const text = editor.state.doc.textContent;
    const from = 1 + text.indexOf("DROPME");
    const to = from + "DROPME".length;
    editor.commands.setTextSelection({ from, to });

    insertReferenceText(editor, "REF", { separateFromAdjacentText: true });

    const markdown = getMarkdown(editor);
    // The selected word is still there — a range-replacing insert would
    // have deleted it and left only "keep REF end".
    expect(markdown).toContain("keep");
    expect(markdown).toContain("DROPME");
    expect(markdown).toContain("end");
    expect(markdown).toContain("REF");
    expect(markdown.indexOf("DROPME")).toBeLessThan(markdown.indexOf("REF"));
  });

  it("inserts at a collapsed caret without disturbing surrounding text", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "before after",
    });

    const caret = 1 + "before ".length;
    editor.commands.setTextSelection(caret);

    insertReferenceText(editor, "REF", { separateFromAdjacentText: true });

    expect(getMarkdown(editor)).toBe("before REF after");
  });

  /**
   * Markdown re-serialization can put "**"/"[...]" characters right next to
   * an unmarked "REF" purely because it sits between two still-marked runs
   * (splitting "bold text" into "bold" + REF + "text" prints as
   * "**bold** REF**text**", which superficially LOOKS like REF is wrapped).
   * A regex over the markdown string can't tell that apart from a real bug,
   * so these assert directly against the ProseMirror node the inserted text
   * became — the authoritative source of whether it carries the mark.
   */
  function marksOfInsertedNode(editor: Editor, text: string): number | null {
    let marks: number | null = null;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text === text) marks = node.marks.length;
    });
    return marks;
  }

  it("keeps a reference dropped inside a bold run as plain, unmarked text", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "before **bold text** after",
    });

    const text = editor.state.doc.textContent; // "before bold text after"
    const caret = 1 + text.indexOf("bold ") + "bold ".length;
    editor.commands.setTextSelection(caret);

    insertReferenceText(editor, "REF");

    expect(getMarkdown(editor)).toContain("REF");
    expect(marksOfInsertedNode(editor, "REF")).toBe(0);
  });

  it("keeps a reference dropped inside a link as plain text, outside the mark", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: createEditorExtensions("Write a description"),
      content: "before [a link](https://example.com) after",
    });

    const text = editor.state.doc.textContent; // "before a link after"
    const caret = 1 + text.indexOf("a link") + "a ".length;
    editor.commands.setTextSelection(caret);

    insertReferenceText(editor, "REF");

    expect(getMarkdown(editor)).toContain("REF");
    expect(marksOfInsertedNode(editor, "REF")).toBe(0);
  });
});
