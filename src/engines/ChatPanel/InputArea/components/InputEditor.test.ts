// @vitest-environment jsdom
import React, { act, createElement, createRef } from "react";
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

import type { ComposerInputRef } from "@src/components/ComposerInput";

import InputEditor from "./InputEditor";

const testState = vi.hoisted(() => ({
  composerInputProps: null as Record<string, unknown> | null,
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => ({ sendOnEnter: true }),
}));

vi.mock("@src/components/ComposerInput", async () => {
  const ReactModule = await import("react");
  return {
    default: ReactModule.forwardRef(
      (props: Record<string, unknown>, _ref: React.ForwardedRef<unknown>) => {
        testState.composerInputProps = props;
        return ReactModule.createElement("div", {
          "data-testid": "composer-input",
          "data-class-name": props.className,
        });
      }
    ),
  };
});

describe("InputEditor leading content", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    testState.composerInputProps = null;
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

  function renderEditor(
    leadingContent?: React.ReactNode,
    compact: boolean = false
  ) {
    act(() =>
      root.render(
        createElement(InputEditor, {
          composerInputRef: createRef<ComposerInputRef>(),
          showContextMenu: false,
          contextMenuKeyboardHandlerRef: { current: null },
          placeholder: "Describe what to change…",
          leadingContent,
          compact,
        })
      )
    );
  }

  it("keeps contextual references on the editor line but outside its document", () => {
    renderEditor(createElement("span", null, "Button"));

    const leading = container.querySelector("[data-composer-leading-content]");
    const composer = container.querySelector("[data-testid='composer-input']");

    expect(leading?.textContent).toBe("Button");
    expect(leading?.nextElementSibling).toBe(composer);
    expect(testState.composerInputProps).toMatchObject({
      placeholder: "Describe what to change…",
      className: expect.stringContaining("chat-input-editor-leading"),
    });
    expect(testState.composerInputProps).not.toHaveProperty("leadingContent");
    expect(testState.composerInputProps).not.toHaveProperty("initialContent");
  });

  it("keeps ordinary editors on the existing inset when no reference exists", () => {
    renderEditor();

    expect(
      container.querySelector("[data-composer-leading-content]")
    ).toBeNull();
    expect(testState.composerInputProps?.className).not.toContain(
      "chat-input-editor-leading"
    );
  });

  it("keeps a contextual reference inside the shared single-row editor", () => {
    renderEditor(createElement("span", null, "Button"), true);

    const leading = container.querySelector<HTMLElement>(
      "[data-composer-leading-content]"
    );
    expect(leading?.className).toContain("h-full");
    expect(testState.composerInputProps).toMatchObject({
      minHeight: 0,
      maxHeight: 36,
      overflowY: "visible",
      className: expect.stringContaining("chat-input-compact"),
    });
  });
});
