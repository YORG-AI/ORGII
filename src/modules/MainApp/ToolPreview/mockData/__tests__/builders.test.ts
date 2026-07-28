import { describe, expect, it } from "vitest";

import {
  buildPlaygroundEventsForToolCommands,
  createPlaygroundEventForToolName,
} from "../index";

describe("ToolPreview mock data builders", () => {
  it("creates a minimal event for tools without a rich fixture", () => {
    const event = createPlaygroundEventForToolName(
      "future_unregistered_tool",
      "running"
    );
    expect(event).toMatchObject({
      functionName: "future_unregistered_tool",
      displayStatus: "running",
      args: {},
      result: { success: true },
    });
  });

  it("applies flat command argument overrides", () => {
    const [event] = buildPlaygroundEventsForToolCommands(
      "run_shell",
      ["kill"],
      "completed"
    );
    expect(event.args).toMatchObject({
      action: "kill",
      kill_handle: "bg_3",
      command: undefined,
    });
  });

  it("applies rich argument and result overrides independently", () => {
    const [event] = buildPlaygroundEventsForToolCommands(
      "manage_work_item",
      ["create"],
      "completed"
    );
    expect(event.args).toMatchObject({
      action: "create",
      project_slug: "chat-panel-visual-polish",
      title: "Add plus icon for created rows",
    });
    expect(event.result).toMatchObject({
      content: "Created work item 'Add plus icon for created rows' [CP-108]",
    });
  });

  it("falls back to the command action when no override exists", () => {
    const [event] = buildPlaygroundEventsForToolCommands(
      "future_unregistered_tool",
      ["inspect"],
      "completed"
    );
    expect(event.args).toEqual({ action: "inspect" });
    expect(event.result).toEqual({ success: true });
  });
});
