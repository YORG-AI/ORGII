// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import ComposerInput, {
  type ComposerExternalEdit,
  type ComposerInputRef,
} from "../index";
import { placeCaretAtEnd } from "../selection";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ isDark: false }),
}));

vi.mock("@src/store/skills/installedSkillsAtom", async () => {
  const { atom } = await import("jotai");
  return { installedSkillsAtom: atom([]) };
});

describe("ComposerInput undo for pasted image attachments", () => {
  let root: SmokeRoot;
  let ref: ReturnType<typeof createRef<ComposerInputRef>>;
  let host: HTMLDivElement;

  beforeEach(() => {
    root = createSmokeRoot();
    ref = createRef<ComposerInputRef>();
  });

  afterEach(async () => {
    await root.unmount();
    window.getSelection()?.removeAllRanges();
  });

  async function mount(
    onImagePaste: (files: File[]) => void | ComposerExternalEdit
  ): Promise<void> {
    await root.render(
      createElement(ComposerInput, {
        ref,
        requireCmdEnter: true,
        onContentChange: vi.fn(),
        onSubmit: vi.fn(),
        onImagePaste,
      })
    );
    host = root.container.querySelector('[contenteditable="true"]')!;
    placeCaretAtEnd(host);
  }

  function pasteImage(): Event {
    const file = new File(["png"], "shot.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: {
          length: 1,
          0: { type: "image/png", getAsFile: () => file },
        },
        getData: () => "",
        types: ["Files"],
      },
    });
    act(() => host.dispatchEvent(event));
    return event;
  }

  function pasteText(text: string): void {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        items: { length: 0 },
        getData: (type: string) => (type === "text/plain" ? text : ""),
        types: ["text/plain"],
      },
    });
    act(() => host.dispatchEvent(event));
  }

  function key(shift = false): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    });
    act(() => host.dispatchEvent(event));
    return event;
  }

  it("records a returned handle as an undo step and drives undo/redo", async () => {
    const edit = { undo: vi.fn(), redo: vi.fn() };
    const onImagePaste = vi.fn(() => edit);
    await mount(onImagePaste);

    expect(pasteImage().defaultPrevented).toBe(true);
    expect(onImagePaste).toHaveBeenCalledTimes(1);

    const undo = key();
    expect(undo.defaultPrevented).toBe(true);
    expect(edit.undo).toHaveBeenCalledTimes(1);
    expect(edit.redo).not.toHaveBeenCalled();

    const redo = key(true);
    expect(redo.defaultPrevented).toBe(true);
    expect(edit.redo).toHaveBeenCalledTimes(1);

    key();
    expect(edit.undo).toHaveBeenCalledTimes(2);
  });

  it("keeps the image step separate from surrounding text edits", async () => {
    const edit = { undo: vi.fn(), redo: vi.fn() };
    await mount(() => edit);
    pasteText("before ");
    pasteImage();
    pasteText("after");
    expect(ref.current?.getText()).toBe("before after");

    key();
    expect(ref.current?.getText()).toBe("before ");
    expect(edit.undo).not.toHaveBeenCalled();

    key();
    expect(ref.current?.getText()).toBe("before ");
    expect(edit.undo).toHaveBeenCalledTimes(1);

    key();
    expect(ref.current?.getText()).toBe("");
  });

  it("leaves a void-returning handler outside the history", async () => {
    const onImagePaste = vi.fn();
    await mount(onImagePaste);
    pasteImage();
    expect(onImagePaste).toHaveBeenCalledTimes(1);
    expect(key().defaultPrevented).toBe(false);
  });
});
