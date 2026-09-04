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

describe("ComposerInput undo across IME composition", () => {
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

  async function mount(): Promise<void> {
    await root.render(
      createElement(ComposerInput, {
        ref,
        requireCmdEnter: true,
        onContentChange: onChange,
        onSubmit: vi.fn(),
      })
    );
    host = root.container.querySelector('[contenteditable="true"]')!;
    placeCaretAtEnd(host);
    onChange.mockClear();
  }

  function fire(type: string, init: Record<string, unknown> = {}): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(init)) {
      Object.defineProperty(event, key, { value });
    }
    act(() => host.dispatchEvent(event));
    return event;
  }

  /** Replace the trailing composition text node with `text`. */
  function setCompositionText(node: Text, text: string): void {
    node.textContent = text;
    placeCaretAtEnd(host);
  }

  /**
   * Drive a browser-shaped IME session: compositionstart, N intermediate
   * `input` events while the marked text changes, then the confirmed text
   * and compositionend. Final `input` before compositionend matches the
   * Chromium/WebKit order; the reverse order is covered separately.
   */
  function compose(stages: string[], confirmed: string): void {
    fire("compositionstart");
    const node = document.createTextNode("");
    host.appendChild(node);
    for (const stage of stages) {
      setCompositionText(node, stage);
      fire("input", { inputType: "insertCompositionText", isComposing: true });
    }
    setCompositionText(node, confirmed);
    fire("input", { inputType: "insertCompositionText", isComposing: true });
    fire("compositionend", { data: confirmed });
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

  it("undoes a confirmed composition as one transaction", async () => {
    await mount();
    compose(["n", "ni", "nih", "niha", "nihao"], "你好");
    expect(ref.current?.getText()).toBe("你好");

    const event = undo();
    expect(event.defaultPrevented).toBe(true);
    expect(ref.current?.getText()).toBe("");
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("keeps each composition as its own undo step", async () => {
    await mount();
    compose(["n", "ni"], "你");
    compose(["h", "ha", "hao"], "好");
    expect(ref.current?.getText()).toBe("你好");

    undo();
    expect(ref.current?.getText()).toBe("你");
    undo();
    expect(ref.current?.getText()).toBe("");
  });

  it("does not create history entries for intermediate composition input", async () => {
    await mount();
    compose(["z", "zh", "zho", "zhon", "zhong"], "中");
    undo();
    expect(ref.current?.getText()).toBe("");
    // A second undo has nothing left: the intermediate stages never became
    // separate entries, and the keydown is left to the browser.
    expect(undo().defaultPrevented).toBe(false);
    expect(ref.current?.getText()).toBe("");
  });

  it("commits correctly when the final input event follows compositionend", async () => {
    await mount();
    fire("compositionstart");
    const node = document.createTextNode("");
    host.appendChild(node);
    setCompositionText(node, "ka");
    fire("input", { inputType: "insertCompositionText", isComposing: true });
    setCompositionText(node, "か");
    fire("compositionend", { data: "か" });
    fire("input", { inputType: "insertFromComposition", isComposing: false });
    expect(ref.current?.getText()).toBe("か");

    undo();
    expect(ref.current?.getText()).toBe("");
  });

  it("does not mix a composition into a preceding paste entry", async () => {
    await mount();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: { length: 0 },
        getData: (type: string) => (type === "text/plain" ? "hi " : ""),
        types: ["text/plain"],
      },
    });
    act(() => host.dispatchEvent(paste));
    compose(["n", "ni"], "你");
    expect(ref.current?.getText()).toBe("hi 你");

    undo();
    expect(ref.current?.getText()).toBe("hi ");
    undo();
    expect(ref.current?.getText()).toBe("");
  });
});
