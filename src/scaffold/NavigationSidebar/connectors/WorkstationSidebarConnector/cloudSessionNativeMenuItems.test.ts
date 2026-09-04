import { describe, expect, it, vi } from "vitest";

import { buildCloudSessionNativeMenuItems } from "./cloudSessionNativeMenuItems";

describe("buildCloudSessionNativeMenuItems", () => {
  it("keeps secondary-click and ellipsis destination actions in the canonical team menu", () => {
    const onOpenInNewTab = vi.fn();
    const onOpenInNewWindow = vi.fn();
    const onOpenInMyStation = vi.fn();
    const onCopyUrl = vi.fn();
    const onTogglePin = vi.fn();
    const onRemove = vi.fn();

    const items = buildCloudSessionNativeMenuItems({
      labels: {
        openInNewTab: "Open in New Tab",
        openInNewWindow: "Open in New Window",
        openInMyStation: "Open in My Station",
        copyUrl: "Copy URL",
        togglePin: "Pin",
        remove: "Remove",
      },
      onOpenInNewTab,
      onOpenInNewWindow,
      onOpenInMyStation,
      onCopyUrl,
      onTogglePin,
      onRemove,
    });

    expect(
      items.map((item) => ("item" in item ? item.item : item.text))
    ).toEqual([
      "Open in New Tab",
      "Open in New Window",
      "Open in My Station",
      "Copy URL",
      "Pin",
      "Separator",
      "Remove",
    ]);

    for (const item of items) {
      if ("action" in item) item.action?.("test-menu-item");
    }
    expect(onOpenInNewTab).toHaveBeenCalledOnce();
    expect(onOpenInNewWindow).toHaveBeenCalledOnce();
    expect(onOpenInMyStation).toHaveBeenCalledOnce();
    expect(onCopyUrl).toHaveBeenCalledOnce();
    expect(onTogglePin).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
