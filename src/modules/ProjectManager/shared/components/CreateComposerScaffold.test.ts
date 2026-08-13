import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CreatorContentLayout } from "@src/modules/shared/layouts/blocks";

import {
  CreateComposerHeader,
  CreateComposerPinnedActions,
  CreateComposerTitleInput,
  ManualCreateComposer,
} from "./CreateComposerScaffold";

const editorRef = {
  current: {
    insertFilePill: vi.fn(),
    triggerAtMention: vi.fn(),
    triggerSlashContext: vi.fn(),
  },
};

describe("CreateComposerScaffold", () => {
  it("places pinned actions above the manual composer shell", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualCreateComposer, {
        dataTestId: "manual-create-composer",
        editorRef,
        headerContent: createElement("div", null, "Title field"),
        editorContent: createElement("div", null, "Description field"),
        pinnedActionsContent: createElement("div", null, "Property pills"),
        submitButton: createElement("button", null, "Submit"),
      })
    );

    expect(markup).toContain('data-testid="manual-create-composer"');
    expect(markup).toContain(
      "session-creator-chat-panel-fullscreen-input-shell"
    );
    expect(markup).toContain("composer-breathing");
    expect(markup).toContain("Title field");
    expect(markup).toContain("Description field");
    expect(markup).toContain("Property pills");
    expect(markup).toContain("Submit");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("multiple");
    const composerShellIndex = markup.indexOf(
      "session-creator-chat-panel-fullscreen-input-shell"
    );
    expect(markup.indexOf("Property pills")).toBeLessThan(composerShellIndex);
    expect(markup.indexOf("Title field")).toBeGreaterThan(composerShellIndex);
    expect(markup.indexOf("Description field")).toBeGreaterThan(
      composerShellIndex
    );
  });

  it("uses body typography for the shared Project and Work Item title", () => {
    const markup = renderToStaticMarkup(
      createElement(CreateComposerTitleInput, {
        dataTestId: "create-title",
        onChange: vi.fn(),
        placeholder: "Title",
        value: "",
      })
    );

    expect(markup).toContain('data-testid="create-title"');
    expect(markup).toContain("!text-[14px]");
    expect(markup).toContain("!font-normal");
  });

  it("docks shared manual creator content to the bottom of the page", () => {
    const markup = renderToStaticMarkup(
      createElement(
        CreatorContentLayout,
        {
          placement: "bottom",
          contentDataTestId: "bottom-create-content",
          middleContent: createElement(
            "div",
            { "data-testid": "creator-middle-content" },
            "Suggestions"
          ),
        },
        createElement(
          CreateComposerHeader,
          { dataTestId: "create-header" },
          createElement(
            CreateComposerPinnedActions,
            { dataTestId: "create-actions" },
            "Actions"
          )
        )
      )
    );

    expect(markup).toContain('data-testid="bottom-create-content"');
    expect(markup).toContain('data-testid="create-header"');
    expect(markup).toContain('data-testid="create-actions"');
    expect(markup).toContain('data-testid="creator-middle-content"');
    expect(markup).toContain(
      "absolute inset-x-0 flex -translate-y-1/2 items-center justify-center"
    );
    expect(markup).toContain("top:clamp(9rem, 42%, calc(100% - 20rem))");
    expect(markup).toContain("w-full shrink-0 flex-col pb-3 pt-4");
    expect(markup.indexOf("Suggestions")).toBeLessThan(
      markup.indexOf('data-testid="bottom-create-content"')
    );
    expect(markup).toContain("mt-auto");
    expect(markup).not.toContain("my-auto");
  });

  it("lets Agent launchers fill the shared creator page", () => {
    const markup = renderToStaticMarkup(
      createElement(
        CreatorContentLayout,
        { placement: "fill", contentDataTestId: "agent-create-content" },
        createElement("div", null, "Agent composer")
      )
    );

    expect(markup).toContain('data-testid="agent-create-content"');
    expect(markup).toContain(
      "flex min-h-0 w-full flex-1 flex-col overflow-hidden"
    );
    expect(markup).not.toContain("mt-auto");
  });
});
