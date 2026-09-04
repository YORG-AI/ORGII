export type SidebarTabDisposition = "default" | "replace-all" | "new-tab";

export function resolveSidebarTabDisposition(event: {
  metaKey: boolean;
  ctrlKey: boolean;
}): SidebarTabDisposition {
  return event.metaKey || event.ctrlKey ? "new-tab" : "default";
}

export function completeSidebarTabNavigation(
  disposition: SidebarTabDisposition,
  closeOtherThanActiveTabs: () => void | Promise<void>
): void {
  // Normal navigation lets each destination apply its own placement policy:
  // Launchpad may be consumed by sessions, while substantive tabs survive.
  // Only an explicit replace-all action is allowed to collapse the strip.
  if (disposition === "replace-all") {
    void closeOtherThanActiveTabs();
  }
}
