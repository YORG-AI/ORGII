// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";
import {
  EDIT_HISTORY_EVENT,
  dispatchEditHistoryCommand,
} from "@src/util/dom/editHistoryCommand";

import ComposerInput, { type ComposerInputRef } from "../index";
import { placeCaretAtEnd } from "../selection";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ isDark: false }),
}));

vi.mock("@src/store/skills/installedSkillsAtom", async () => {
  const { atom } = await import("jotai");
  return { installedSkillsAtom: atom([]) };
});

function fakeClipboard(text: string): DataTransfer {
  const items = { length: 0 } as unknown as DataTransferItemList;
  return {
    items,
    getData: (type: string) => (type === "text/plain" ? text : ""),
    types: ["text/plain"],
  } as unknown as DataTransfer;
}

describe("ComposerInput undo after paste", () => {
  let root: SmokeRoot;
  let ref: ReturnType<typeof createRef<ComposerInputRef>>;
  let host: HTMLDivElement;
  const onChange = vi.fn();

  beforeEach(() => {
    root = createSmokeRoot();
    ref = createRef<ComposerInputRef>();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await root.unmount();
    window.getSelection()?.removeAllRanges();
  });

  async function mount(text = ""): Promise<void> {
    await root.render(
      createElement(ComposerInput, {
        ref,
        initialContent: text,
        requireCmdEnter: true,
        onContentChange: onChange,
        onSubmit: vi.fn(),
      })
    );
    host = root.container.querySelector('[contenteditable="true"]')!;
    placeCaretAtEnd(host);
    onChange.mockClear();
  }

  function paste(text: string): Event {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: fakeClipboard(text),
    });
    act(() => host.dispatchEvent(event));
    return event;
  }

  function typeText(text: string): void {
    for (const char of text) {
      const before = new Event("beforeinput", {
        bubbles: true,
        cancelable: true,
      }) as InputEvent;
      Object.defineProperty(before, "inputType", { value: "insertText" });
      Object.defineProperty(before, "data", { value: char });
      act(() => host.dispatchEvent(before));
      // Simulate the browser's native insertion.
      const selection = window.getSelection()!;
      const range = selection.getRangeAt(0);
      const node = document.createTextNode(char);
      range.insertNode(node);
      placeCaretAtEnd(host);
      const input = new Event("input", { bubbles: true }) as InputEvent;
      Object.defineProperty(input, "inputType", { value: "insertText" });
      act(() => host.dispatchEvent(input));
    }
  }

  function pressKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => host.dispatchEvent(event));
    return event;
  }

  it("Cmd+Z removes a plain-text paste into an empty editor", async () => {
    await mount();
    expect(paste("hello world").defaultPrevented).toBe(true);
    expect(ref.current?.getText()).toBe("hello world");

    const undo = pressKey("z", { metaKey: true });
    expect(undo.defaultPrevented).toBe(true);
    expect(ref.current?.getText()).toBe("");
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("Cmd+Z after typing then pasting removes only the paste", async () => {
    await mount();
    typeText("abc ");
    expect(ref.current?.getText()).toBe("abc ");
    paste("pasted");
    expect(ref.current?.getText()).toBe("abc pasted");

    pressKey("z", { metaKey: true });
    expect(ref.current?.getText()).toBe("abc ");

    pressKey("z", { metaKey: true, shiftKey: true });
    expect(ref.current?.getText()).toBe("abc pasted");
  });

  it("native historyUndo beforeinput routes to the structured history", async () => {
    await mount();
    paste("hello");
    const before = new Event("beforeinput", {
      bubbles: true,
      cancelable: true,
    }) as InputEvent;
    Object.defineProperty(before, "inputType", { value: "historyUndo" });
    act(() => host.dispatchEvent(before));
    expect(before.defaultPrevented).toBe(true);
    expect(ref.current?.getText()).toBe("");
  });

  it("Edit → Undo from the app menu undoes a paste without native history", async () => {
    const execCommand = vi.fn();
    document.execCommand = execCommand;
    await mount();
    paste("from menu");
    expect(ref.current?.getText()).toBe("from menu");
    host.focus();

    let handled = false;
    act(() => {
      handled = dispatchEditHistoryCommand("undo");
    });
    expect(handled).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
    expect(ref.current?.getText()).toBe("");

    act(() => {
      handled = dispatchEditHistoryCommand("redo");
    });
    expect(handled).toBe(true);
    expect(ref.current?.getText()).toBe("from menu");
  });

  it("consumes the menu command even when there is nothing to undo", async () => {
    await mount();
    host.focus();
    const event = new CustomEvent(EDIT_HISTORY_EVENT.undo, {
      bubbles: true,
      cancelable: true,
    });
    act(() => host.dispatchEvent(event));
    // Browser-native history cannot restore pills, so the composer never
    // lets the command fall through to `document.execCommand`.
    expect(event.defaultPrevented).toBe(true);
    expect(ref.current?.getText()).toBe("");
  });

  it("Cmd+Z removes a large paste that was collapsed into a pill", async () => {
    await mount();
    typeText("see ");
    const large = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    paste(large);
    expect(host.querySelector("[data-composer-pill]")).not.toBeNull();
    expect(ref.current?.getText()).toContain("see ");

    pressKey("z", { metaKey: true });
    expect(host.querySelector("[data-composer-pill]")).toBeNull();
    expect(ref.current?.getText()).toBe("see ");
  });
});
