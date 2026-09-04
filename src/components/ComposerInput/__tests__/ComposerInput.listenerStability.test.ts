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

vi.mock("@src/config/pillTokens", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@src/config/pillTokens")>();
  return { ...actual, storePillText: vi.fn() };
});

describe("ComposerInput native listener stability across pill edits", () => {
  let root: SmokeRoot;
  let ref: ReturnType<typeof createRef<ComposerInputRef>>;
  let host: HTMLDivElement;
  const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
  const removeSpy = vi.spyOn(HTMLElement.prototype, "removeEventListener");

  beforeEach(async () => {
    root = createSmokeRoot();
    ref = createRef<ComposerInputRef>();
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
    addSpy.mockClear();
    removeSpy.mockClear();
  });

  afterEach(async () => {
    await root.unmount();
    window.getSelection()?.removeAllRanges();
  });

  const hostBinds = (spy: typeof addSpy, type: string) =>
    spy.mock.calls.filter(
      (call, index) =>
        (spy.mock.contexts as unknown[])[index] === host && call[0] === type
    ).length;

  it("does not rewire host listeners when a pill is inserted or removed", async () => {
    act(() => ref.current?.insertFilePill("/tmp/a.ts", false, "file", "a.ts"));
    act(() => ref.current?.insertFilePill("/tmp/b.ts", false, "file", "b.ts"));
    expect(ref.current?.getFilePills().map((pill) => pill.fileName)).toEqual([
      "a.ts",
      "b.ts",
    ]);

    act(() => ref.current?.removeFilePill("/tmp/a.ts"));
    expect(ref.current?.getFilePills().map((pill) => pill.fileName)).toEqual([
      "b.ts",
    ]);

    for (const type of ["keydown", "paste", "beforeinput", "cut", "drop"]) {
      expect(hostBinds(addSpy, type), `${type} re-added`).toBe(0);
      expect(hostBinds(removeSpy, type), `${type} removed`).toBe(0);
    }
  });

  it("keeps a ref held from before the pill edit fully functional", async () => {
    const before = ref.current!;
    act(() => before.insertFilePill("/tmp/c.ts", false, "file", "c.ts"));
    act(() => before.insertMentionText("hello "));
    expect(before.getText()).toContain("hello ");

    const undo = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => host.dispatchEvent(undo));
    expect(undo.defaultPrevented).toBe(true);
    expect(before.getText()).not.toContain("hello ");
    expect(before.getFilePills()).toHaveLength(1);
  });
});
