import { describe, expect, it } from "vitest";

import { getShortcutAccelerator, getShortcutKeys } from "./shortcutDisplay";
import { ALL_SHORTCUTS } from "./shortcuts";

const DISPLAY_SHORTCUT_IDS = [
  "new_session",
  "format_document",
  "go_to_definition",
  "find_references",
  "spotlight_navigate",
  "spotlight_select",
  "spotlight_switch_focus",
  "spotlight_back",
  "spotlight_close",
  "spotlight_command_mode",
] as const;

const NATIVE_ACCELERATOR_IDS = [
  "new_session",
  "window_open_folder",
  "window_close",
  "quit_app",
  "open_model_selector",
  "open_workspace_selector",
  "open_branch_selector",
  "open_location_selector",
  "open_settings",
  "maximize_work_station",
  "file_menu_new_file",
  "file_menu_new_folder",
  "file_menu_rename",
  "file_menu_delete",
  "file_menu_duplicate",
  "file_menu_copy",
  "file_menu_paste",
  "file_menu_copy_path",
  "file_menu_copy_relative_path",
] as const;

describe("shortcut display registry", () => {
  it("loads the paired arrows for Spotlight navigation", () => {
    expect(getShortcutKeys("spotlight_navigate")).toBe("↑ ↓");
  });

  it("keeps shortcut IDs unique", () => {
    const ids = ALL_SHORTCUTS.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(DISPLAY_SHORTCUT_IDS)("loads display keys for %s", (id) => {
    expect(getShortcutKeys(id)).toBeTruthy();
  });

  it.each(NATIVE_ACCELERATOR_IDS)(
    "loads the native accelerator for %s",
    (id) => {
      expect(getShortcutAccelerator(id)).toBeTruthy();
    }
  );
});
