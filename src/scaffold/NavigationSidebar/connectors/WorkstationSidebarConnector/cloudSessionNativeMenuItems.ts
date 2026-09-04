import type { NativeMenuItemOptions } from "@src/util/platform/tauri/nativeMenuPopup";

interface BuildCloudSessionNativeMenuItemsParams {
  labels: {
    openInNewTab: string;
    openInNewWindow: string;
    openInMyStation: string;
    copyUrl: string;
    togglePin: string;
    remove: string;
  };
  onOpenInNewTab: () => void;
  onOpenInNewWindow: () => void;
  onOpenInMyStation: () => void;
  onCopyUrl: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
}

/**
 * The canonical native menu for an actionable Team Conversation row.
 * Both secondary-click and the trailing ellipsis consume this exact list.
 */
export function buildCloudSessionNativeMenuItems({
  labels,
  onOpenInNewTab,
  onOpenInNewWindow,
  onOpenInMyStation,
  onCopyUrl,
  onTogglePin,
  onRemove,
}: BuildCloudSessionNativeMenuItemsParams): NativeMenuItemOptions[] {
  return [
    { text: labels.openInNewTab, action: onOpenInNewTab },
    { text: labels.openInNewWindow, action: onOpenInNewWindow },
    { text: labels.openInMyStation, action: onOpenInMyStation },
    { text: labels.copyUrl, action: onCopyUrl },
    { text: labels.togglePin, action: onTogglePin },
    { item: "Separator" },
    { text: labels.remove, action: onRemove },
  ];
}
