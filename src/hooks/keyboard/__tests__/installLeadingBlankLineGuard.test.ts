// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Textarea from "@src/components/Textarea";
import { createSmokeRoot } from "@src/test/reactSmokeHarness";
import * as lineBreakPolicy from "@src/util/data/canInsertLineBreak";

import { installLeadingBlankLineGuard } from "../installLeadingBlankLineGuard";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ isDark: false }),
}));

function lineBreak(
  target: HTMLElement,
  options: InputEventInit = {}
): InputEvent {
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertLineBreak",
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

describe("native textarea leading-line-break guard", () => {
  let dispose: () => void;
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    dispose = installLeadingBlankLineGuard();
    textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
  });

  afterEach(() => {
    dispose();
    textarea.parentElement?.closest("[data-test-wrapper]")?.remove();
    textarea.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["", 0, 0],
    [" \t\u200B", 3, 3],
    ["existing message", 0, 0],
    ["    indented message", 4, 4],
    ["first line\nsecond line", 0, 10],
    ["\nexisting message", 5, 5],
  ])("blocks a line break in %j at selection %i–%i", (value, start, end) => {
    textarea.value = value;
    textarea.setSelectionRange(start, end);

    expect(lineBreak(textarea).defaultPrevented).toBe(true);
    expect(textarea.value).toBe(value);
    expect(textarea.selectionStart).toBe(start);
    expect(textarea.selectionEnd).toBe(end);
  });

  it.each(["hello", "    code", "first\n", "first\n\n", "first\n  next"])(
    "allows further line breaks after content in %j",
    (value) => {
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
      expect(lineBreak(textarea).defaultPrevented).toBe(false);
    }
  );

  it("also blocks native paragraph insertion", () => {
    expect(
      lineBreak(textarea, { inputType: "insertParagraph" }).defaultPrevented
    ).toBe(true);
  });

  it("does not claim composition, ordinary typing, paste, deletion, or undo", () => {
    expect(lineBreak(textarea, { isComposing: true }).defaultPrevented).toBe(
      false
    );
    for (const inputType of [
      "insertText",
      "insertFromPaste",
      "deleteContentBackward",
      "historyUndo",
    ]) {
      expect(lineBreak(textarea, { inputType }).defaultPrevented).toBe(false);
    }
  });

  it("leaves Enter and modifier shortcuts to the field's key handler", () => {
    const onKeyDown = vi.fn();
    textarea.addEventListener("keydown", onKeyDown);
    for (const modifiers of [{}, { shiftKey: true }, { metaKey: true }]) {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onKeyDown).toHaveBeenCalledTimes(3);
  });

  it.each(["cm-editor", "CodeMirror", "monaco-editor", "xterm"])(
    "does not change %s input semantics",
    (className) => {
      const wrapper = document.createElement("div");
      wrapper.className = className;
      wrapper.dataset.testWrapper = "true";
      document.body.appendChild(wrapper);
      wrapper.appendChild(textarea);
      expect(lineBreak(textarea).defaultPrevented).toBe(false);
    }
  );

  it("leaves readonly and disabled fields alone", () => {
    textarea.readOnly = true;
    expect(lineBreak(textarea).defaultPrevented).toBe(false);
    textarea.readOnly = false;
    textarea.disabled = true;
    expect(lineBreak(textarea).defaultPrevented).toBe(false);
  });

  it("covers the shared Textarea without each caller installing a handler", async () => {
    const root = createSmokeRoot();
    const onChange = vi.fn();
    try {
      await root.render(createElement(Textarea, { onChange }));
      const field = root.container.querySelector("textarea")!;
      expect(lineBreak(field).defaultPrevented).toBe(true);
      expect(field.value).toBe("");
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await root.unmount();
    }
  });

  it("installs once, disposes fully, and can reinstall without stale cleanup", () => {
    dispose();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    dispose = installLeadingBlankLineGuard();
    expect(installLeadingBlankLineGuard()).toBe(dispose);
    expect(
      add.mock.calls.filter(([type]) => type === "beforeinput")
    ).toHaveLength(1);

    const oldDispose = dispose;
    dispose();
    expect(lineBreak(textarea).defaultPrevented).toBe(false);
    expect(remove).toHaveBeenCalledWith(
      "beforeinput",
      expect.any(Function),
      true
    );

    dispose = installLeadingBlankLineGuard();
    oldDispose();
    expect(installLeadingBlankLineGuard()).toBe(dispose);
    expect(lineBreak(textarea).defaultPrevented).toBe(true);
  });

  it("does no policy work while idle or on unrelated input", () => {
    vi.useFakeTimers();
    const evaluate = vi.spyOn(lineBreakPolicy, "canInsertLineBreak");
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    lineBreak(textarea, { inputType: "insertText", data: "a" });
    expect(evaluate).not.toHaveBeenCalled();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.advanceTimersByTime(60_000);
    expect(evaluate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    lineBreak(textarea);
    expect(evaluate).toHaveBeenCalledOnce();
  });
});
