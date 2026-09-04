import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ListChevronsDownUpIcon } from "@src/icons";

import type { ProjectData } from "../shared/components/PropertiesPanel/types";
import { getProjectContextMenuItems } from "./projectContextMenu";

const project = { id: "project-1", name: "Project One" } as ProjectData;
const t = (key: string) => key;

describe("getProjectContextMenuItems", () => {
  it("omits the destructive action when project administration is forbidden", () => {
    const items = getProjectContextMenuItems({ project, t });
    expect(items.some((item) => item.id === "delete")).toBe(false);
    expect(items.some((item) => item.id === "divider-delete")).toBe(false);
  });

  it("includes delete only when an allowed handler exists", () => {
    const onDelete = vi.fn();
    const items = getProjectContextMenuItems({ project, t, onDelete });
    const item = items.find((candidate) => candidate.id === "delete");
    expect(item?.disabled).not.toBe(true);
    item?.action?.();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("includes unlink only when the row provides a synced-source handler", () => {
    const onUnlinkSource = vi.fn();
    const items = getProjectContextMenuItems({
      project,
      t,
      onUnlinkSource,
    });
    const item = items.find((candidate) => candidate.id === "unlink-source");

    expect(item?.label).toBe(
      "settings.sync.adapterPicker.detachProjectMenuLabel"
    );
    item?.action?.();
    expect(onUnlinkSource).toHaveBeenCalledOnce();
  });

  it("uses the expand-properties icon for the More properties entry", () => {
    const items = getProjectContextMenuItems({ project, t });
    const moreProperties = items.find((item) => item.id === "more-properties");

    expect(isValidElement(moreProperties?.icon)).toBe(true);
    if (!isValidElement<{ icon?: unknown }>(moreProperties?.icon)) return;
    expect(moreProperties.icon.props.icon).toBe(ListChevronsDownUpIcon);
  });
});
