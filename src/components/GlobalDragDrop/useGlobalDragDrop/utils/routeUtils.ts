/**
 * Drop-target utilities for GlobalDragDrop
 *
 * Drag-drop behavior is derived from the DOM target + payload shape, not the
 * current route. A page "supports" dropping files into chat iff a
 * [data-chat-drop-target] element is mounted and visible.
 */
import { ROUTES } from "@src/config/routes";

const CHAT_DROP_TARGET_SELECTOR =
  "[data-chat-drop-target]:not([data-chat-file-drop-disabled])";

export function hasVisibleChatDropTarget(): boolean {
  const dropTargets = document.querySelectorAll(CHAT_DROP_TARGET_SELECTOR);
  return Array.from(dropTargets).some((dropTarget) => {
    const rect = dropTarget.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

/**
 * Whether folder drops on the current page should trigger the "add as
 * repository" modal. Only the Start page currently opts into this —
 * everywhere else a folder drop just adds a folder pill to chat.
 */
export function isRepositoryDropPage(): boolean {
  return window.location.pathname.startsWith(ROUTES.app.home.start.path);
}
