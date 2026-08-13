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

vi.mock("@src/modules/shared/components/RichMarkdownEditor", async () => {
  const { forwardRef } = await import("react");
  return {
    RICH_MARKDOWN_COMPOSER_TOOLBAR_CLASS: "shared-inline-markdown-toolbar",
    default: forwardRef<HTMLDivElement, Record<string, unknown>>(
      function MockRichMarkdownEditor(props, ref) {
        return createElement("div", {
          ref,
          "data-testid": "mock-markdown-editor",
          "data-toolbar-mode": props.toolbarMode,
          "data-toolbar-class": props.toolbarClassName,
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
  it("exposes the shared inline Markdown formats for composer surfaces", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectContentEditor, {
        ...baseProps,
        descriptionToolbarMode: "inline",
      })
    );

    expect(markup).toContain('data-toolbar-mode="inline"');
    expect(markup).toContain(
      'data-toolbar-class="shared-inline-markdown-toolbar"'
    );
  });

  it("preserves the selection toolbar for existing content editors", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectContentEditor, baseProps)
    );

    expect(markup).toContain('data-toolbar-mode="floating"');
    expect(markup).toContain('data-toolbar-class="work-item-toolbar"');
  });
});
