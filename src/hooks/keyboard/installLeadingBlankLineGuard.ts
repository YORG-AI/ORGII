import { canInsertLineBreak } from "@src/util/data/canInsertLineBreak";

let disposeGuard: (() => void) | undefined;

/**
 * Covers shared and native textareas without claiming Enter shortcuts. The
 * browser emits beforeinput only when it is actually about to insert a line
 * break, including soft-keyboard input. Rich composers guard their own DOM
 * insertion operation; code editors and terminal input keep their semantics.
 */
export function installLeadingBlankLineGuard(): () => void {
  if (disposeGuard) return disposeGuard;

  const handleBeforeInput = (event: InputEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      (event.inputType !== "insertLineBreak" &&
        event.inputType !== "insertParagraph")
    ) {
      return;
    }

    const target = event.target;
    if (
      !(target instanceof HTMLTextAreaElement) ||
      target.disabled ||
      target.readOnly ||
      target.closest(".cm-editor, .CodeMirror, .monaco-editor, .xterm")
    ) {
      return;
    }

    if (!canInsertLineBreak(target.value.slice(0, target.selectionStart))) {
      event.preventDefault();
    }
  };

  document.addEventListener("beforeinput", handleBeforeInput, true);
  const dispose = () => {
    document.removeEventListener("beforeinput", handleBeforeInput, true);
    if (disposeGuard === dispose) disposeGuard = undefined;
  };
  disposeGuard = dispose;
  return dispose;
}
