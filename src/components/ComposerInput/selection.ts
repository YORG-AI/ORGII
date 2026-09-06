/**
 * Selection helpers for the contenteditable host.
 *
 * Pill spans are `contenteditable="false"`, so the browser already treats
 * the entire pill as a single navigation unit. The only piece we have to
 * handle ourselves is *programmatically* placing the caret — after
 * inserting a pill, after `setContent`, after `clear`, etc.
 */
import { PILL_DATA_ATTR } from "./utils";

/** Place the caret at the end of the contenteditable host. */
export function placeCaretAtEnd(host: HTMLElement): void {
  host.focus();
  const range = document.createRange();
  range.selectNodeContents(host);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Place the caret immediately after the given DOM node. */
export function placeCaretAfter(node: Node): void {
  const range = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, (node.textContent ?? "").length);
  } else {
    const parent = node.parentNode;
    if (parent) {
      const childIndex = Array.prototype.indexOf.call(parent.childNodes, node);
      range.setStart(parent, childIndex + 1);
    } else {
      range.setStartAfter(node);
    }
  }
  range.collapse(true);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Return the currently active Range *if* it lives inside `host`. Otherwise
 * return a synthetic range positioned at the end of `host` so callers can
 * safely insert content even when the editor was never focused.
 */
function fallbackEndRange(host: HTMLElement): Range {
  const fallback = document.createRange();
  fallback.selectNodeContents(host);
  fallback.collapse(false);
  return fallback;
}

function selectionRangeInsideHost(host: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (
    host.contains(range.startContainer) &&
    host.contains(range.endContainer)
  ) {
    return range.cloneRange();
  }

  return null;
}

export function rangeInsideHost(host: HTMLElement): Range {
  return selectionRangeInsideHost(host) ?? fallbackEndRange(host);
}

function focusedRangeInsideHost(host: HTMLElement): Range {
  const activeElement = document.activeElement;
  const editorHasFocus = activeElement === host || host.contains(activeElement);
  if (!editorHasFocus) return fallbackEndRange(host);
  return selectionRangeInsideHost(host) ?? fallbackEndRange(host);
}

function getCaretRangeFromPoint(x: number, y: number): Range | null {
  if (document.caretRangeFromPoint) {
    return document.caretRangeFromPoint(x, y);
  }

  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }

  return null;
}

export function placeCaretAtTextOffset(
  host: HTMLElement,
  targetOffset: number
): void {
  host.focus();
  const range = document.createRange();
  let remaining = Math.max(0, targetOffset);

  const placeAtEnd = () => {
    range.selectNodeContents(host);
    range.collapse(false);
  };

  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (remaining <= text.length) {
        range.setStart(node, remaining);
        range.collapse(true);
        return true;
      }
      remaining -= text.length;
      return false;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node as HTMLElement;
    if (element.tagName === "BR") {
      if (remaining <= 1) {
        range.setStartAfter(element);
        range.collapse(true);
        return true;
      }
      remaining -= 1;
      return false;
    }

    if (element.getAttribute(PILL_DATA_ATTR) === "true") {
      const textLength = (element.textContent ?? "").length;
      if (remaining <= 0) {
        range.setStartBefore(element);
        range.collapse(true);
        return true;
      }
      if (remaining <= textLength) {
        range.setStartAfter(element);
        range.collapse(true);
        return true;
      }
      remaining -= textLength;
      return false;
    }

    for (const child of Array.from(element.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };

  for (const child of Array.from(host.childNodes)) {
    if (visit(child)) {
      const selection = window.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
  }

  placeAtEnd();
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

export function placeCaretAfterPill(pill: HTMLElement): void {
  const host = pill.closest<HTMLElement>('[contenteditable="true"]');
  host?.focus({ preventScroll: true });

  const range = document.createRange();
  const nextSibling = pill.nextSibling;
  if (nextSibling?.nodeType === Node.TEXT_NODE) {
    const text = nextSibling.textContent ?? "";
    range.setStart(nextSibling, text.length);
  } else {
    range.setStartAfter(pill);
  }
  range.collapse(true);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

export function placeCaretAtPoint(
  host: HTMLElement,
  x: number,
  y: number
): boolean {
  const range = getCaretRangeFromPoint(x, y);
  if (!range) return false;

  if (!host.contains(range.startContainer)) return false;

  const selection = window.getSelection();
  if (!selection) return false;

  host.focus();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * Insert a node at the current caret position (or at the end of `host` if
 * no in-host selection exists). The caret is placed immediately after the
 * inserted node so the next typed character lands after the pill.
 */
export function insertNodeAtCaret(host: HTMLElement, node: Node): void {
  const range = focusedRangeInsideHost(host);
  host.focus();
  range.deleteContents();
  range.insertNode(node);
  placeCaretAfter(node);
}

/** Find the nearest pill ancestor (or self) of a DOM node, if any. */
export function findPillAncestor(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as HTMLElement;
      if (element.getAttribute(PILL_DATA_ATTR) === "true") return element;
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * Compute the offset (in plain-text characters, with pills counted as their
 * display name) from the start of `host` to the given DOM point. Used to
 * detect whether `/` was typed at position 0.
 */
export function caretTextOffset(host: HTMLElement, range: Range): number {
  const preRange = document.createRange();
  preRange.selectNodeContents(host);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}
