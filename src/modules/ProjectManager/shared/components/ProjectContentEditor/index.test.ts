import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ProjectContentEditor from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/hooks/input", () => ({
  useComposerInput: () => ({
    showContextMenu: false,
    atSearchQuery: "",
    handleAtMention: vi.fn(),
    handleAtMentionClose: vi.fn(),
    contextMenuKeyboardOpened: false,
    showSlashMenu: false,
    slashQuery: "",
    setSlashQuery: vi.fn(),
    slashCommandKeyboardHandlerRef: { current: null },
    handleSlashCommand: vi.fn(),
    handleSlashCommandClose: vi.fn(),
    handleModeSelect: vi.fn(),
    currentMode: "default",
    filteredSlashItems: [],
    slashLoading: false,
  }),
}));

vi.mock(
  "@src/engines/ChatPanel/InputArea/components/ContextMenuPortal",
  () => ({ default: () => null })
);

vi.mock(
  "@src/engines/ChatPanel/InputArea/components/SlashCommandPortal",
  () => ({ default: () => null })
);

vi.mock("@src/modules/shared/components/MarkdownTextareaEditor", async () => {
  const { forwardRef } = await import("react");
  return {
    default: forwardRef<HTMLDivElement, Record<string, unknown>>(
      function MockMarkdownTextareaEditor(props, ref) {
        return createElement("div", {
          ref,
          "data-testid": "mock-markdown-editor",
          "data-editor-kind": "write-preview",
          "data-min-height": props.minHeight,
          "data-editable": String(props.editable),
        });
      }
    ),
  };
});

const baseProps = {
  title: "",
  onTitleChange: vi.fn(),
  titleVisible: false,
  separatorVisible: false,
};

describe("ProjectContentEditor", () => {
  it("uses the consolidated Write / Preview Markdown editor", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectContentEditor, baseProps)
    );

    expect(markup).toContain('data-editor-kind="write-preview"');
    expect(markup).toContain('data-min-height="200"');
  });

  it("propagates read-only descriptions to the shared editor", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectContentEditor, { ...baseProps, editable: false })
    );

    expect(markup).toContain('data-editable="false"');
  });
});
