/**
 * Drop-target utilities for GlobalDragDrop
 *
 * Drag-drop behavior is derived from the DOM target + payload shape, not the
 * current route. A page "supports" dropping files into chat iff a
 * [data-chat-drop-target] element is mounted and visible.
 */
const CHAT_DROP_TARGET_SELECTOR =
  "[data-chat-drop-target]:not([data-chat-file-drop-disabled])";

export function hasVisibleChatDropTarget(): boolean {
  const dropTargets = document.querySelectorAll(CHAT_DROP_TARGET_SELECTOR);
  return Array.from(dropTargets).some((dropTarget) => {
    const rect = dropTarget.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}
