// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import ComposerInput, { type ComposerInputRef } from "../index";
import { placeCaretAtEnd } from "../selection";
import { historyCoalesceKey } from "../useEditorOperations";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ isDark: false }),
}));

vi.mock("@src/store/skills/installedSkillsAtom", async () => {
  const { atom } = await import("jotai");
  return { installedSkillsAtom: atom([]) };
});

describe("historyCoalesceKey", () => {
  it("groups word characters, whitespace, and deletions separately", () => {
    expect(historyCoalesceKey("insertText", "a")).toBe("typing");
    expect(historyCoalesceKey("insertText", " ")).toBe("typing:whitespace");
    expect(historyCoalesceKey("insertText", "\n")).toBe("typing:whitespace");
    expect(historyCoalesceKey("deleteContentBackward", null)).toBe(
      "deleteContentBackward"
    );
    expect(historyCoalesceKey("deleteWordForward", null)).toBe(
      "deleteWordForward"
    );
  });

  it("leaves structural edits as their own undo steps", () => {
    expect(historyCoalesceKey("insertFromPaste", "x")).toBeUndefined();
    expect(historyCoalesceKey("insertParagraph", null)).toBeUndefined();
    expect(historyCoalesceKey(undefined, undefined)).toBeUndefined();
  });
});

describe("ComposerInput undo granularity for typed text", () => {
  let root: SmokeRoot;
  let ref: ReturnType<typeof createRef<ComposerInputRef>>;
  let host: HTMLDivElement;
  let now = 0;

  beforeEach(() => {
    root = createSmokeRoot();
    ref = createRef<ComposerInputRef>();
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    await root.unmount();
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  async function mount(): Promise<void> {
    await root.render(
      createElement(ComposerInput, {
        ref,
        requireCmdEnter: true,
        onContentChange: vi.fn(),
        onSubmit: vi.fn(),
      })
    );
    host = root.container.querySelector('[contenteditable="true"]')!;
    placeCaretAtEnd(host);
  }

  function fire(type: string, init: Record<string, unknown> = {}): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(init)) {
      Object.defineProperty(event, key, { value });
    }
    act(() => host.dispatchEvent(event));
    return event;
  }

  /** Type one character the way a browser does, `gapMs` after the last. */
  function typeChar(char: string, gapMs = 50): void {
    now += gapMs;
    fire("beforeinput", { inputType: "insertText", data: char });
    const range = window.getSelection()!.getRangeAt(0);
    range.insertNode(document.createTextNode(char));
    placeCaretAtEnd(host);
    fire("input", { inputType: "insertText", data: char });
  }

  function backspace(gapMs = 50): void {
    now += gapMs;
    fire("beforeinput", { inputType: "deleteContentBackward", data: null });
    const last = host.lastChild;
    if (last?.nodeType === Node.TEXT_NODE) {
      const text = last.textContent ?? "";
      if (text.length > 1) last.textContent = text.slice(0, -1);
      else last.remove();
    }
    placeCaretAtEnd(host);
    fire("input", { inputType: "deleteContentBackward", data: null });
  }

  function typeText(text: string): void {
    for (const char of text) typeChar(char);
  }

  function undo(): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => host.dispatchEvent(event));
    return event;
  }

  function redo(): void {
    act(() =>
      host.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      )
    );
  }

  it("undoes a typed burst word by word instead of character by character", async () => {
    await mount();
    typeText("hello world");
    expect(ref.current?.getText()).toBe("hello world");

    undo();
    expect(ref.current?.getText()).toBe("hello ");
    undo();
    expect(ref.current?.getText()).toBe("hello");
    undo();
    expect(ref.current?.getText()).toBe("");
    expect(undo().defaultPrevented).toBe(false);
  });

  it("redo restores a whole coalesced group", async () => {
    await mount();
    typeText("abc");
    undo();
    expect(ref.current?.getText()).toBe("");
    redo();
    expect(ref.current?.getText()).toBe("abc");
  });

  it("starts a new group after a pause", async () => {
    await mount();
    typeText("ab");
    typeChar("c", 1_500);
    typeText("d");

    undo();
    expect(ref.current?.getText()).toBe("ab");
    undo();
    expect(ref.current?.getText()).toBe("");
  });

  it("keeps a backspace run separate from the typing before it", async () => {
    await mount();
    typeText("abcd");
    backspace();
    backspace();
    expect(ref.current?.getText()).toBe("ab");

    undo();
    expect(ref.current?.getText()).toBe("abcd");
    undo();
    expect(ref.current?.getText()).toBe("");
  });

  it("does not fold typing into a paste, or a paste into typing", async () => {
    await mount();
    typeText("hi");
    now += 50;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: { length: 0 },
        getData: (type: string) => (type === "text/plain" ? " there" : ""),
        types: ["text/plain"],
      },
    });
    act(() => host.dispatchEvent(paste));
    typeText("!");
    expect(ref.current?.getText()).toBe("hi there!");

    undo();
    expect(ref.current?.getText()).toBe("hi there");
    undo();
    expect(ref.current?.getText()).toBe("hi");
    undo();
    expect(ref.current?.getText()).toBe("");
  });

  it("typing after an undo opens a fresh group", async () => {
    await mount();
    typeText("abc");
    undo();
    typeText("xy");
    expect(ref.current?.getText()).toBe("xy");
    undo();
    expect(ref.current?.getText()).toBe("");
    expect(undo().defaultPrevented).toBe(false);
  });
});
