/**
 * Edit → Undo / Redo dispatch that works for editors with their own history.
 *
 * Native menu items (macOS Edit menu, the Windows top-bar menu) used to send
 * WebKit's `undo:` selector / `document.execCommand("undo")`. Both only walk
 * the browser's own undo manager, which never learns about programmatic
 * edits: ComposerInput cancels `paste` and inserts text/pills itself, so a
 * paste (or a pill insert, or an IME commit) had no native entry to undo.
 *
 * This helper first offers the command to the focused element as a
 * cancelable DOM event. Editors that keep structured history (ComposerInput)
 * listen for it and call `preventDefault()` once they have handled it. When
 * nothing consumes the event we fall back to the browser's native history so
 * plain inputs, textareas and CodeMirror keep working as before.
 */

export type EditHistoryCommand = "undo" | "redo";

export const EDIT_HISTORY_EVENT: Record<EditHistoryCommand, string> = {
  undo: "orgii-edit-undo",
  redo: "orgii-edit-redo",
};

/**
 * Dispatch `command` to the focused element, falling back to the browser's
 * native history when no structured editor consumes it.
 *
 * Returns `true` when a structured editor handled the command.
 */
export function dispatchEditHistoryCommand(
  command: EditHistoryCommand
): boolean {
  const target = document.activeElement ?? document.body;
  const event = new CustomEvent(EDIT_HISTORY_EVENT[command], {
    bubbles: true,
    cancelable: true,
  });
  const notConsumed = target.dispatchEvent(event);
  if (!notConsumed) return true;
  document.execCommand(command);
  return false;
}
