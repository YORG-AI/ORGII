import { isValidElement } from "react";

import type { KanbanTask } from "@src/features/KanbanBoard";

import { mapKanbanTaskToSessionTableItem } from "./sessionTableItem";

function makeTask(): KanbanTask {
  return {
    id: "session-1",
    title: "Test session",
    status: "in_progress",
    impact: {
      filesChanged: 3,
      linesAdded: 7,
      linesRemoved: 5,
      relatedCommits: 2,
      committedFiles: 1,
      committedRatePercent: 33,
    },
  };
}

describe("mapKanbanTaskToSessionTableItem", () => {
  it("truncates workspace labels after 15 characters", () => {
    const item = mapKanbanTaskToSessionTableItem({
      task: {
        ...makeTask(),
        workspaceName: "12345678901234567890",
      },
      statusLabel: "In progress",
    });

    expect(item.workspaceLabel).toBe("123456789012345...");
    expect(item.workspaceTitle).toBe("12345678901234567890");
  });

  it("keeps added and removed lines separate at the table font size", () => {
    const item = mapKanbanTaskToSessionTableItem({
      task: makeTask(),
      statusLabel: "In progress",
    });

    expect(isValidElement(item.impactLabel)).toBe(true);
    if (!isValidElement(item.impactLabel)) throw new Error("missing impact");
    expect(item.impactLabel.props).toMatchObject({
      additions: 7,
      deletions: 5,
      variant: "plain",
      size: "inherit",
      reserveValueWidth: false,
      valueClassName: "font-normal",
    });
    expect(item.filesChangedLabel).toBe("3");
    expect(item.relatedCommitsLabel).toBe("2");
  });

  it("leaves the impact cell empty when no lines changed", () => {
    const task = makeTask();
    task.impact = {
      ...task.impact!,
      linesAdded: 0,
      linesRemoved: 0,
    };

    const item = mapKanbanTaskToSessionTableItem({
      task,
      statusLabel: "In progress",
    });

    expect(item.impactLabel).toBeUndefined();
  });
});
