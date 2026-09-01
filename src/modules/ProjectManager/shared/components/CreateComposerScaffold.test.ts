// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CREATOR_COMPOSER_POSITION } from "@src/config/sessionCreatorConfig";
import { CreatorContentLayout } from "@src/modules/shared/layouts/blocks";
import {
  changeCreatorComposerPositionAtom,
  creatorRepoChromePositionAtom,
} from "@src/store/session/creatorRepoChromePositionAtom";

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
    expect(markup).toContain(
      "session-creator-chat-panel-fullscreen-composer-group"
    );
    expect(markup).toContain("composer-bottom-glow");
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
    expect(markup).toContain("text-[14px]!");
    expect(markup).toContain("font-normal!");
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

describe("Manual creator skills/actions placement", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  let previousActEnvironment: boolean | undefined;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it("keeps actions above both creators' inputs regardless of input or trail placement", () => {
    const store = createStore();
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          ...["work-item", "project"].map((surface) =>
            createElement(
              CreatorContentLayout,
              { key: surface, placement: "bottom" },
              createElement(ManualCreateComposer, {
                dataTestId: surface,
                editorRef,
                headerContent: createElement("input", {
                  name: "title",
                  defaultValue: `${surface} title`,
                }),
                editorContent: createElement("textarea", {
                  defaultValue: `${surface} draft`,
                }),
                pinnedActionsContent: createElement(
                  "button",
                  { name: "actions" },
                  "Skills/actions"
                ),
              })
            )
          )
        )
      );
    });

    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[name="title"], textarea'
      )
    );
    expect(inputs).toHaveLength(4);
    for (const input of inputs) input.value += " edited";

    const expectActionsAboveInput = () => {
      for (const [index, input] of inputs.entries()) {
        expect(
          container.querySelectorAll('input[name="title"], textarea')[index]
        ).toBe(input);
        expect(input.value).toContain(" edited");
        const actions = input
          .closest("[data-testid]")
          ?.querySelector('button[name="actions"]');
        expect(actions).not.toBeNull();
        expect(actions?.compareDocumentPosition(input)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING
        );
      }
    };

    expectActionsAboveInput();
    act(() =>
      store.set(
        changeCreatorComposerPositionAtom,
        CREATOR_COMPOSER_POSITION.MIDDLE
      )
    );
    expectActionsAboveInput();
    act(() => store.set(creatorRepoChromePositionAtom, "top"));
    expectActionsAboveInput();
    act(() => {
      store.set(
        changeCreatorComposerPositionAtom,
        CREATOR_COMPOSER_POSITION.BOTTOM
      );
      store.set(creatorRepoChromePositionAtom, "bottom");
    });
    expectActionsAboveInput();
  });
});
