// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposerSnapshot } from "@src/components/ComposerInput/types";
import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import { useEditMode } from "../useEditMode";

describe("useEditMode initial message text", () => {
  const root = createSmokeRoot();

  afterEach(async () => {
    await root.unmount();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("opens an existing message without leading blank lines and keeps its pills", async () => {
    vi.useFakeTimers();
    const setContent = vi.fn<(value: string | ComposerSnapshot) => void>();
    const editor = {
      getEditor: () => ({}),
      getText: () => "",
      getTextWithPills: () => "",
      setContent,
      focus: vi.fn(),
    };
    const composerInputRef = { current: editor };

    function Harness(): null {
      useEditMode({
        effectiveEditMode: true,
        isEditMode: true,
        initialContent:
          "\n \t\n    inspect note.txt [file:/tmp/note.txt]\n\n  next line",
        composerInputRef,
      });
      return null;
    }

    await root.render(createElement(Harness));
    expect(setContent).toHaveBeenCalledWith({
      parts: [
        { kind: "text", text: "    inspect " },
        {
          kind: "pill",
          attrs: expect.objectContaining({
            fileName: "note.txt",
            filePath: "/tmp/note.txt",
          }),
        },
        { kind: "newline" },
        { kind: "newline" },
        { kind: "text", text: "  next line" },
      ],
    });
  });
});
