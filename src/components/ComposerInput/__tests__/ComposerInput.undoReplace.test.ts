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

describe("ComposerInput undo history across whole-document replacement", () => {
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

  function paste(text: string): void {
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

  it("clear() after a send leaves nothing for Cmd+Z to resurrect", async () => {
    await mount();
    paste("secret draft");
    expect(ref.current?.getText()).toBe("secret draft");

    act(() => ref.current?.clear());
    expect(ref.current?.getText()).toBe("");

    const event = undo();
    expect(event.defaultPrevented).toBe(false);
    expect(ref.current?.getText()).toBe("");
  });

  it("setContent(string) starts a fresh history", async () => {
    await mount();
    paste("session A text");
    act(() => ref.current?.setContent("restored draft for session B"));

    expect(undo().defaultPrevented).toBe(false);
    expect(ref.current?.getText()).toBe("restored draft for session B");
  });

  it("setContent(snapshot) starts a fresh history and later edits still undo", async () => {
    await mount();
    paste("old");
    act(() =>
      ref.current?.setContent({
        parts: [{ kind: "text", text: "restored " }],
      })
    );
    placeCaretAtEnd(host);
    paste("more");
    expect(ref.current?.getText()).toBe("restored more");

    undo();
    expect(ref.current?.getText()).toBe("restored ");
    expect(undo().defaultPrevented).toBe(false);
    expect(ref.current?.getText()).toBe("restored ");
  });

  it("partial edits through the imperative API remain undoable", async () => {
    await mount();
    paste("hello ");
    act(() => ref.current?.insertMentionText("@alice "));
    expect(ref.current?.getText()).toBe("hello @alice ");

    undo();
    expect(ref.current?.getText()).toBe("hello ");
    undo();
    expect(ref.current?.getText()).toBe("");
  });

  it("redo is dropped along with undo on replacement", async () => {
    await mount();
    paste("first");
    undo();
    expect(ref.current?.getText()).toBe("");
    act(() => ref.current?.setContent("replacement"));

    const redoEvent = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => host.dispatchEvent(redoEvent));
    expect(redoEvent.defaultPrevented).toBe(false);
    expect(ref.current?.getText()).toBe("replacement");
  });
});
