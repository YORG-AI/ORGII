// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createEditorExtensions } from "./config";

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
});
