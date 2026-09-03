export type SidebarTabDisposition = "replace-all" | "new-tab";

export function resolveSidebarTabDisposition(event: {
  metaKey: boolean;
  ctrlKey: boolean;
}): SidebarTabDisposition {
  return event.metaKey || event.ctrlKey ? "new-tab" : "replace-all";
}

export function completeSidebarTabNavigation(
  disposition: SidebarTabDisposition,
  closeOtherThanActiveTabs: () => void | Promise<void>
): void {
  if (disposition === "replace-all") {
    void closeOtherThanActiveTabs();
  }
}
