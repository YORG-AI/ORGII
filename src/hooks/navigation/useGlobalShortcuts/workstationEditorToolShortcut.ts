/**
 * Resolves the workstation editor-tool chords ⌘G / ⌘E / ⌘J (open File
 * Folder / Source Control / Terminal tab).
 *
 * The chords stay inert while an editable surface has focus because they
 * carry editor-local meanings there — ⌘G is find-next in CodeMirror's
 * search keymap, for example.
 *
 * Contract: this resolver only ever claims its own three chords. `null`
 * means "not ours — keep processing the keydown", never "abort". The
 * caller must fall through to the global shortcuts (⌘W close-tab,
 * ⌘1/2/3 station switch, …) on `null`, regardless of focus.
 */
export type WorkstationEditorToolShortcut =
  | "open_file_folder_tab"
  | "open_source_control_tab"
  | "open_terminal_tab";

export function resolveWorkstationEditorToolShortcut(
  code: string,
  options: { editableTarget: boolean }
): WorkstationEditorToolShortcut | null {
  if (options.editableTarget) return null;
  switch (code) {
    case "KeyG":
      return "open_file_folder_tab";
    case "KeyE":
      return "open_source_control_tab";
    case "KeyJ":
      return "open_terminal_tab";
    default:
      return null;
  }
}
