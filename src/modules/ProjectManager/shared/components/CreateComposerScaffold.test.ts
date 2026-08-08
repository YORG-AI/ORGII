import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CreatorContentLayout } from "@src/modules/shared/layouts/blocks";

import {
  CreateComposerAgentFrame,
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
  it("keeps create fields, pinned actions, and submit inside one manual composer shell", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualCreateComposer, {
        centered: true,
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
    expect(markup).toContain("Title field");
    expect(markup).toContain("Description field");
    expect(markup).toContain("Property pills");
    expect(markup).toContain("Submit");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("multiple");
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

  it("shares centered, Agent, header, and pinned-action layout primitives", () => {
    const markup = renderToStaticMarkup(
      createElement(
        CreatorContentLayout,
        {
          centered: true,
          centeredDataTestId: "centered-create",
        },
        createElement(
          CreateComposerAgentFrame,
          { centered: true },
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
      )
    );

    expect(markup).toContain('data-testid="centered-create"');
    expect(markup).toContain('data-testid="create-header"');
    expect(markup).toContain('data-testid="create-actions"');
    expect(markup).toContain("my-auto");
    expect(markup).toContain("shrink-0 flex-col py-6");
    expect(markup).not.toContain("shrink-0 pt-6");
  });
});
