/**
 * Keyboard handling for ComposerInput.
 *
 * Handles keyboard behavior on a plain `keydown` listener attached to a
 * contenteditable host:
 *
 *  - IME composition guard (skipped via `event.isComposing`)
 *  - @ mention dropdown navigation delegation
 *  - Slash command dropdown navigation delegation
 *  - @ detection (after the character lands, mark mention active and notify)
 *  - / detection (after the character lands, mark slash command active and notify)
 *  - Enter to submit (Cmd/Ctrl+Enter or bare Enter based on `requireCmdEnter`)
 *  - Escape to close dropdowns
 *
 * All callbacks are accessed via getters at event time so a single
 * handler instance can survive every prop change without re-binding.
 */
import {
  caretTextOffset,
  findPillAncestor,
  rangeInsideHost,
} from "./selection";
import { PILL_DATA_ATTR } from "./utils";

/**
 * Move the caret one position to the left, skipping over any pill as a unit
 * and ensuring it always lands in a text node to the pill's left (not inside
 * the contenteditable="false" span or before the host root).
 */
function moveCaretLeftPastPill(
  host: HTMLElement,
  event: KeyboardEvent
): boolean {
  if (event.key !== "ArrowLeft") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
    return false;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed)
    return false;
  const range = selection.getRangeAt(0);
  if (!host.contains(range.startContainer)) return false;

  const container = range.startContainer;
  const offset = range.startOffset;

  // Case 1: caret is in a text node at offset 0 — look left for a pill.
  if (container.nodeType === Node.TEXT_NODE && offset === 0) {
    const prevSibling = container.previousSibling;
    const pill = findPillAncestor(prevSibling);
    if (!pill) return false;
    // Land in the text node to the pill's left (or before the pill in the parent).
    const pillPrev = pill.previousSibling;
    const newRange = document.createRange();
    if (pillPrev?.nodeType === Node.TEXT_NODE) {
      const txt = pillPrev.textContent ?? "";
      newRange.setStart(pillPrev, txt.length);
    } else {
      const pillIndex = Array.prototype.indexOf.call(
        pill.parentNode!.childNodes,
        pill
      );
      newRange.setStart(pill.parentNode!, pillIndex);
    }
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
    return true;
  }

  // Case 2: caret is directly inside the host at an element boundary.
  if (container.nodeType === Node.ELEMENT_NODE && container === host) {
    const candidate = host.childNodes[offset - 1] ?? null;
    const pill = findPillAncestor(candidate);
    if (!pill) return false;
    const pillPrev = pill.previousSibling;
    const newRange = document.createRange();
    if (pillPrev?.nodeType === Node.TEXT_NODE) {
      const txt = pillPrev.textContent ?? "";
      newRange.setStart(pillPrev, txt.length);
    } else {
      const pillIndex = Array.prototype.indexOf.call(host.childNodes, pill);
      newRange.setStart(host, pillIndex);
    }
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
    return true;
  }

  return false;
}

/**
 * Move the caret one position to the right, skipping over any pill as a unit
 * and landing in the text node to the pill's right.
 */
function moveCaretRightPastPill(
  host: HTMLElement,
  event: KeyboardEvent
): boolean {
  if (event.key !== "ArrowRight") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
    return false;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed)
    return false;
  const range = selection.getRangeAt(0);
  if (!host.contains(range.startContainer)) return false;

  const container = range.startContainer;
  const offset = range.startOffset;

  // Case 1: caret is in a text node at its end — look right for a pill.
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? "";
    if (offset !== text.length) return false;
    const nextSibling = container.nextSibling;
    const pill = findPillAncestor(nextSibling);
    if (!pill) return false;
    const pillNext = pill.nextSibling;
    const newRange = document.createRange();
    if (pillNext?.nodeType === Node.TEXT_NODE) {
      newRange.setStart(pillNext, 0);
    } else {
      const pillIndex = Array.prototype.indexOf.call(
        pill.parentNode!.childNodes,
        pill
      );
      newRange.setStart(pill.parentNode!, pillIndex + 1);
    }
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
    return true;
  }

  // Case 2: caret is directly inside the host at an element boundary.
  if (container.nodeType === Node.ELEMENT_NODE && container === host) {
    const candidate = host.childNodes[offset] ?? null;
    const pill = findPillAncestor(candidate);
    if (!pill) return false;
    const pillNext = pill.nextSibling;
    const newRange = document.createRange();
    if (pillNext?.nodeType === Node.TEXT_NODE) {
      newRange.setStart(pillNext, 0);
    } else {
      const pillIndex = Array.prototype.indexOf.call(host.childNodes, pill);
      newRange.setStart(host, pillIndex + 1);
    }
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
    return true;
  }

  return false;
}

const DROPDOWN_NAV_KEYS = ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"];

export function canStartSlashCommand(
  text: string,
  slashIndex: number
): boolean {
  if (slashIndex < 0) return false;
  const previousChar = slashIndex > 0 ? text[slashIndex - 1] : "";
  return !previousChar || /\s/.test(previousChar);
}

export interface MentionState {
  active: boolean;
  /**
   * Character offset (within `getText()`) of the position right after the
   * trigger character. The active query is the substring from `startOffset`
   * to the current caret position.
   */
  startOffset: number;
  /**
   * `true` when the trigger was a typed "@" key (the character lives in the
   * editor at `startOffset - 1`), `false` when opened programmatically via
   * `triggerAtMention()`.
   */
  hasAtChar?: boolean;
  hasTriggerChar?: boolean;
}

export interface KeyDownHandlerContext {
  host: () => HTMLDivElement | null;
  isComposing: (event: KeyboardEvent) => boolean;
  getAtMention: () => MentionState;
  setAtMention: (state: MentionState) => void;
  getSlashCommand: () => MentionState;
  setSlashCommand: (state: MentionState) => void;
  getOnKeyDownForDropdown: () =>
    | ((event: KeyboardEvent) => boolean)
    | undefined;
  getOnKeyDownForSlashDropdown: () =>
    | ((event: KeyboardEvent) => boolean)
    | undefined;
  getOnAtMention: () =>
    | ((query: string, pos: { x: number; y: number }) => void)
    | undefined;
  getOnAtMentionClose: () => (() => void) | undefined;
  getOnSlashCommand: () =>
    | ((query: string, pos?: { x: number; y: number }) => void)
    | undefined;
  getOnSlashCommandClose: () => (() => void) | undefined;
  getOnSubmit: () => ((text: string) => void) | undefined;
  /** Read the plain-text content of the editor (pills serialized to fileName) */
  getText: () => string;
  /** Insert a literal newline at the caret. Used for Shift+Enter / bare Enter. */
  insertNewline: () => void;
  undo: () => boolean;
  redo: () => boolean;
  /** Whether bare Enter inserts a newline (false) or submits (true). */
  requireCmdEnter: boolean;
  slashTriggerMode: "command" | "context";
}

/**
 * Read caret coordinates so the host can position the @ mention popover.
 * Falls back to the host's bounding box if there is no live range (e.g. the
 * user never clicked into the editor before triggering @).
 */
function caretCoords(host: HTMLElement): { x: number; y: number } {
  const range = rangeInsideHost(host);
  const rects = range.getClientRects();
  if (rects.length > 0) {
    const rect = rects[0];
    return { x: rect.left, y: rect.bottom };
  }
  const rect = host.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

export type PillDeleteDirection = "backward" | "forward";

function removePillAndPlaceCaret(
  host: HTMLElement,
  pill: HTMLElement,
  direction: PillDeleteDirection,
  dispatchInput = true
): boolean {
  if (!host.contains(pill)) return false;

  const parent = pill.parentNode;
  if (!parent) return false;

  const nextSibling = pill.nextSibling;
  const previousSibling = pill.previousSibling;

  parent.removeChild(pill);

  // Place the caret at the nearest meaningful position after deletion.
  // Walk outward from where the pill was to find the best anchor:
  //   Backspace → prefer end of the closest non-empty text node to the left,
  //               then the start of the closest non-empty text node to the right.
  //   Delete    → prefer start of the closest non-empty text node to the right,
  //               then the end of the closest non-empty text node to the left.
  // Empty sentinel text nodes (guaranteed by insertPill) are skipped — they
  // are zero-width and placing the caret at offset 0 inside one of them looks
  // identical to "jumped to the beginning".
  const findNonEmptyTextLeft = (start: ChildNode | null): Text | null => {
    let node = start;
    while (node) {
      if (
        node.nodeType === Node.TEXT_NODE &&
        (node.textContent ?? "").length > 0
      ) {
        return node as Text;
      }
      node = node.previousSibling;
    }
    return null;
  };
  const findNonEmptyTextRight = (start: ChildNode | null): Text | null => {
    let node = start;
    while (node) {
      if (
        node.nodeType === Node.TEXT_NODE &&
        (node.textContent ?? "").length > 0
      ) {
        return node as Text;
      }
      node = node.nextSibling;
    }
    return null;
  };

  const range = document.createRange();

  if (direction === "backward") {
    const left = findNonEmptyTextLeft(previousSibling as ChildNode | null);
    if (left && parent.contains(left)) {
      range.setStart(left, (left.textContent ?? "").length);
    } else {
      const right = findNonEmptyTextRight(nextSibling as ChildNode | null);
      if (right && parent.contains(right)) {
        range.setStart(right, 0);
      } else {
        // Host is now all pills / empty sentinels — place after the last
        // remaining child, or at 0 if the host is empty.
        range.setStart(parent, parent.childNodes.length);
      }
    }
  } else {
    const right = findNonEmptyTextRight(nextSibling as ChildNode | null);
    if (right && parent.contains(right)) {
      range.setStart(right, 0);
    } else {
      const left = findNonEmptyTextLeft(previousSibling as ChildNode | null);
      if (left && parent.contains(left)) {
        range.setStart(left, (left.textContent ?? "").length);
      } else {
        range.setStart(parent, parent.childNodes.length);
      }
    }
  }

  range.collapse(true);

  const selection = window.getSelection();
  if (selection) {
    host.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
  }

  if (dispatchInput) {
    host.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "deleteContent" })
    );
  }
  return true;
}

export function removePillForDeleteDirection(
  host: HTMLElement,
  direction: PillDeleteDirection,
  dispatchInput = true
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  if (
    !host.contains(range.startContainer) ||
    !host.contains(range.endContainer)
  ) {
    return false;
  }

  if (!selection.isCollapsed) {
    const includesPill = Array.from(
      host.querySelectorAll<HTMLElement>(`[${PILL_DATA_ATTR}]`)
    ).some((pill) => range.intersectsNode(pill));
    if (!includesPill) return false;
    range.deleteContents();
    if (dispatchInput) {
      host.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContent" })
      );
    }
    return true;
  }

  const pillAncestor = findPillAncestor(range.startContainer);
  if (pillAncestor) {
    return removePillAndPlaceCaret(
      host,
      pillAncestor,
      direction,
      dispatchInput
    );
  }

  const container = range.startContainer;
  const offset = range.startOffset;

  // Check for an adjacent pill next to the caret's text node.
  // If the caret is anywhere inside a short spacer text node that sits
  // directly next to a pill, treat the whole spacer as zero-width and
  // remove the adjacent pill.
  const SPACER_MAX_LEN = 2;
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? "";
    const isShortSpacer =
      text.replace(/\s/g, "").length === 0 && text.length <= SPACER_MAX_LEN;
    if (direction === "backward") {
      const prev = container.previousSibling;
      const pill = findPillAncestor(prev);
      if (pill && (offset === 0 || isShortSpacer)) {
        return removePillAndPlaceCaret(host, pill, direction, dispatchInput);
      }
    }
    if (direction === "forward") {
      const next = container.nextSibling;
      const pill = findPillAncestor(next);
      if (pill && (offset === text.length || isShortSpacer)) {
        return removePillAndPlaceCaret(host, pill, direction, dispatchInput);
      }
    }
  }

  if (container.nodeType === Node.ELEMENT_NODE) {
    const element = container as Element;
    const siblingIndex = direction === "backward" ? offset - 1 : offset;
    const candidate = element.childNodes[siblingIndex] ?? null;
    const adjacentPill = findPillAncestor(candidate);
    if (adjacentPill) {
      return removePillAndPlaceCaret(
        host,
        adjacentPill,
        direction,
        dispatchInput
      );
    }
  }

  return false;
}

function removePillForDeleteKey(
  host: HTMLElement,
  event: KeyboardEvent
): boolean {
  if (event.key !== "Backspace" && event.key !== "Delete") return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return removePillForDeleteDirection(
    host,
    event.key === "Backspace" ? "backward" : "forward"
  );
}

export function createKeyDownHandler(ctx: KeyDownHandlerContext) {
  return (event: KeyboardEvent): void => {
    if (ctx.isComposing(event)) return;
    const host = ctx.host();
    if (!host) return;

    const onAtKeys = ctx.getOnKeyDownForDropdown();
    if (ctx.getAtMention().active && onAtKeys) {
      if (DROPDOWN_NAV_KEYS.includes(event.key)) {
        const handled = onAtKeys(event);
        if (handled) {
          event.preventDefault();
          return;
        }
      }
    }

    const onSlashKeys = ctx.getOnKeyDownForSlashDropdown();
    // Delegate to the slash-command dropdown handler when:
    //   a) the inline "/" menu is active (slashCommandRef.active), OR
    //   b) the handler itself accepts the key (covers the "+" button header menu
    //      where slashCommandRef.active is always false because no "/" was typed).
    // This avoids a double-guard where slashCommandRef.active is false but the
    // dropdown is visibly open (opened via button, not via typed "/").
    if (onSlashKeys && DROPDOWN_NAV_KEYS.includes(event.key)) {
      const handled = onSlashKeys(event);
      if (handled) {
        event.preventDefault();
        return;
      }
    }

    if (removePillForDeleteKey(host, event)) {
      event.preventDefault();
      ctx.setAtMention({ active: false, startOffset: 0 });
      ctx.setSlashCommand({ active: false, startOffset: 0 });
      ctx.getOnAtMentionClose()?.();
      ctx.getOnSlashCommandClose()?.();
      return;
    }

    if (
      moveCaretLeftPastPill(host, event) ||
      moveCaretRightPastPill(host, event)
    ) {
      event.preventDefault();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      const handled = event.shiftKey ? ctx.redo() : ctx.undo();
      if (handled) {
        event.preventDefault();
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
      const handled = ctx.redo();
      if (handled) {
        event.preventDefault();
        return;
      }
    }

    // Cmd/Ctrl+A → select all editor content. WebKit-based contenteditable
    // hosts can refuse the native shortcut in some embedded layouts, so we
    // drive the selection ourselves to guarantee parity with ComposerInput.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(host);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return;
    }

    if (event.key === "@") {
      // Let the character land in the editor, then mark the mention as
      // active if the input event did not already activate it.
      setTimeout(() => {
        if (ctx.getAtMention().active) return;
        const liveHost = ctx.host();
        if (!liveHost) return;
        const range = rangeInsideHost(liveHost);
        const offset = caretTextOffset(liveHost, range);
        ctx.setAtMention({
          active: true,
          startOffset: offset,
          hasAtChar: true,
        });
        ctx.getOnAtMention()?.("", caretCoords(liveHost));
      }, 0);
    }

    if (event.key === "/" && !ctx.getAtMention().active) {
      // Let the character land in the editor, then mark the slash command as
      // active if the input event did not already activate it. Slash commands
      // are triggerable from non-empty input when `/` starts a token, not when
      // it appears inside path-like text such as `github/x/y`.
      setTimeout(() => {
        if (ctx.getSlashCommand().active || ctx.getAtMention().active) return;
        const liveHost = ctx.host();
        if (!liveHost) return;
        const range = rangeInsideHost(liveHost);
        const offset = caretTextOffset(liveHost, range);
        const text = ctx.getText().slice(0, offset);
        if (!canStartSlashCommand(text, offset - 1)) return;
        ctx.setSlashCommand({
          active: true,
          startOffset: offset,
          hasTriggerChar: true,
        });
        ctx.getOnSlashCommand()?.("", caretCoords(liveHost));
      }, 0);
    }

    if (
      event.key === "Enter" &&
      !ctx.getAtMention().active &&
      !ctx.getSlashCommand().active
    ) {
      if (ctx.requireCmdEnter) {
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          const text = ctx.getText();
          if (text.trim()) ctx.getOnSubmit()?.(text);
          return;
        }
        // Shift+Enter or bare Enter → newline.
        event.preventDefault();
        ctx.insertNewline();
        return;
      }
      // `requireCmdEnter` is false → "send on Enter" is on. Bare Enter
      // submits; Shift+Enter and Ctrl/Cmd+Enter both insert a newline so the
      // user always has an explicit "insert line break" chord available.
      if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        const text = ctx.getText();
        if (text.trim()) ctx.getOnSubmit()?.(text);
        return;
      }
      event.preventDefault();
      ctx.insertNewline();
      return;
    }

    if (event.key === "Escape" && ctx.getAtMention().active) {
      ctx.setAtMention({ active: false, startOffset: 0 });
      ctx.getOnAtMentionClose()?.();
      return;
    }
    if (event.key === "Escape" && ctx.getSlashCommand().active) {
      ctx.setSlashCommand({ active: false, startOffset: 0 });
      ctx.getOnSlashCommandClose()?.();
    }
  };
}
