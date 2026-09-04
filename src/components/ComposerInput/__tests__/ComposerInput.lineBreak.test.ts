// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import ComposerInput, { type ComposerInputRef } from "../index";
import { placeCaretAtEnd } from "../selection";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ isDark: false }),
}));

vi.mock("@src/store/skills/installedSkillsAtom", async () => {
  const { atom } = await import("jotai");
  return { installedSkillsAtom: atom([]) };
});

describe("ComposerInput line breaks in new and edited text", () => {
  let root: SmokeRoot;
  let ref: ReturnType<typeof createRef<ComposerInputRef>>;
  let host: HTMLDivElement;
  const onChange = vi.fn();
  const onSubmit = vi.fn();

  beforeEach(() => {
    root = createSmokeRoot();
    ref = createRef<ComposerInputRef>();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await root.unmount();
    window.getSelection()?.removeAllRanges();
  });

  async function mount(text = "", requireCmdEnter = true): Promise<void> {
    await root.render(
      createElement(ComposerInput, {
        ref,
        initialContent: text,
        requireCmdEnter,
        onContentChange: onChange,
        onSubmit,
      })
    );
    host = root.container.querySelector('[contenteditable="true"]')!;
    placeCaretAtEnd(host);
    onChange.mockClear();
  }

  function pressEnter(options: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...options,
    });
    act(() => host.dispatchEvent(event));
    return event;
  }

  it.each([
    [true, {}],
    [true, { shiftKey: true }],
    [false, { shiftKey: true }],
    [false, { metaKey: true }],
    [false, { ctrlKey: true }],
  ])(
    "blocks empty first-line newline chords (requireCmdEnter=%s, %j)",
    async (requireCmdEnter, chord) => {
      await mount(" \t", requireCmdEnter);
      const before = host.innerHTML;
      expect(pressEnter(chord).defaultPrevented).toBe(true);
      expect(host.innerHTML).toBe(before);
      expect(ref.current?.getText()).toBe(" \t");
      expect(onChange).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it("does not split the first line before its content or replace it with a newline", async () => {
    await mount("    edited message\nnext line");
    const text = host.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 4);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    pressEnter();
    expect(ref.current?.getText()).toBe("    edited message\nnext line");

    range.selectNodeContents(host);
    selection.removeAllRanges();
    selection.addRange(range);
    pressEnter({ shiftKey: true });
    expect(ref.current?.getText()).toBe("    edited message\nnext line");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("allows later blank lines and preserves indentation in an edited draft", async () => {
    await mount();
    act(() => ref.current?.setContent("    edited message"));
    placeCaretAtEnd(host);
    pressEnter();
    pressEnter();
    expect(ref.current?.getText()).toBe("    edited message\n\n");
    expect(onChange).toHaveBeenLastCalledWith("    edited message\n\n");
  });

  it("counts a reference pill as first-line content", async () => {
    await mount();
    act(() =>
      ref.current?.setContent({
        parts: [
          {
            kind: "pill",
            attrs: {
              fileName: "compact",
              filePath: "/compact",
              iconType: "skill",
              isFolder: false,
              lineStart: null,
              lineEnd: null,
            },
          },
        ],
      })
    );
    placeCaretAtEnd(host);
    pressEnter();
    expect(ref.current?.getTextWithPills()).toContain(
      "compact [skill:/compact]"
    );
    expect(ref.current?.getText()).toMatch(/\n$/u);
  });

  it.each(["insertParagraph", "insertLineBreak"])(
    "guards %s without a keyboard event",
    async (inputType) => {
      await mount();
      const attempt = () => {
        const event = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType,
        });
        act(() => host.dispatchEvent(event));
        return event;
      };
      expect(attempt().defaultPrevented).toBe(true);
      expect(ref.current?.getText()).toBe("");
      expect(onChange).not.toHaveBeenCalled();

      act(() => ref.current?.setContent("first line"));
      placeCaretAtEnd(host);
      expect(attempt().defaultPrevented).toBe(true);
      expect(ref.current?.getText()).toBe("first line\n");

      act(() =>
        host.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "z",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          })
        )
      );
      expect(ref.current?.getText()).toBe("first line");
    }
  );

  it("preserves IME composition and both submit modes", async () => {
    await mount();
    expect(pressEnter({ isComposing: true }).defaultPrevented).toBe(false);
    const composition = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
      isComposing: true,
    });
    host.dispatchEvent(composition);
    expect(composition.defaultPrevented).toBe(false);

    const noncancelable = new InputEvent("beforeinput", {
      bubbles: true,
      inputType: "insertLineBreak",
    });
    host.dispatchEvent(noncancelable);
    expect(ref.current?.getText()).toBe("");
    expect(onChange).not.toHaveBeenCalled();

    act(() => ref.current?.setContent("submit this"));
    pressEnter({ metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith("submit this");

    await mount("", false);
    pressEnter();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(ref.current?.getText()).toBe("submit this");
  });
});
