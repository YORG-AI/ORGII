import { describe, expect, it } from "vitest";

import { resolveWorkstationEditorToolShortcut } from "../workstationEditorToolShortcut";

describe("resolveWorkstationEditorToolShortcut", () => {
  it("claims the three editor-tool chords outside editable surfaces", () => {
    expect(
      resolveWorkstationEditorToolShortcut("KeyG", { editableTarget: false })
    ).toBe("open_file_folder_tab");
    expect(
      resolveWorkstationEditorToolShortcut("KeyE", { editableTarget: false })
    ).toBe("open_source_control_tab");
    expect(
      resolveWorkstationEditorToolShortcut("KeyJ", { editableTarget: false })
    ).toBe("open_terminal_tab");
  });

  it("stays inert while an editable surface has focus (⌘G is find-next in CodeMirror)", () => {
    for (const code of ["KeyG", "KeyE", "KeyJ"]) {
      expect(
        resolveWorkstationEditorToolShortcut(code, { editableTarget: true })
      ).toBeNull();
    }
  });

  // Regression: the old inline guard `return`ed out of the whole keydown
  // handler for editable targets, so ⌘W never closed the tab while
  // CodeMirror had focus. Not-ours keys must resolve to null (fall through
  // to the global shortcuts) in BOTH focus states — never abort.
  it("never claims foreign keys, regardless of focus", () => {
    for (const editableTarget of [true, false]) {
      for (const code of ["KeyW", "Digit1", "KeyN", "KeyP", "KeyT"]) {
        expect(
          resolveWorkstationEditorToolShortcut(code, { editableTarget })
        ).toBeNull();
      }
    }
  });
});
