const WORKSTATION_SHORTCUT_SURFACE_SELECTOR =
  "[data-workbench-surface], [data-workstation-pane-control]";

/**
 * Keeps shortcut ownership with the last explicitly interacted pane. Neutral
 * targets such as document.body and portaled overlays must not clear it.
 */
export function resolveChatPanelShortcutOwnership(
  container: HTMLElement | null,
  target: EventTarget | null,
  currentOwnership: boolean
): boolean {
  if (!container || !(target instanceof Node)) return currentOwnership;

  const chatSurface =
    container.closest<HTMLElement>("[data-fullmode-chat-wrapper]") ?? container;
  if (chatSurface.contains(target)) return true;

  if (
    target instanceof Element &&
    target.closest(WORKSTATION_SHORTCUT_SURFACE_SELECTOR)
  ) {
    return false;
  }

  return currentOwnership;
}
