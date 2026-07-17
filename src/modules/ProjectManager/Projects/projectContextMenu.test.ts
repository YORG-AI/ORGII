import { describe, expect, it, vi } from "vitest";

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
});
