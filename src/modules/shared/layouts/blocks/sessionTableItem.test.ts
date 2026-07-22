import { isValidElement } from "react";

import type { KanbanTask } from "@src/features/KanbanBoard";

import { truncateSessionOwnerLabel } from "./SessionTable";
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

  it("maps the organization creator name into the owner column", () => {
    const item = mapKanbanTaskToSessionTableItem({
      task: {
        id: "session-org",
        title: "Review release",
        status: "in_progress",
        createdBy: { id: "user-1", name: "Ada Lovelace" },
      },
      statusLabel: "In progress",
    });

    expect(item.ownerLabel).toBe("Ada Lovelace");
  });

  it("disables rows whose projected task has no open action", () => {
    const item = mapKanbanTaskToSessionTableItem({
      task: { ...makeTask(), canOpen: false },
      statusLabel: "In progress",
    });

    expect(item.disabled).toBe(true);
  });

  it("passes a List-owned row action through to the shared table item", () => {
    const rowAction = "Take over";
    const item = mapKanbanTaskToSessionTableItem({
      task: makeTask(),
      statusLabel: "In progress",
      rowAction,
    });

    expect(item.rowAction).toBe(rowAction);
  });

  it("uses text-1 for both the agent and model icons", () => {
    const item = mapKanbanTaskToSessionTableItem({
      task: {
        ...makeTask(),
        cliAgentType: "codex",
        modelName: "gpt-5.6-sol",
      },
      statusLabel: "In progress",
    });

    expect(isValidElement(item.agentIcon)).toBe(true);
    expect(isValidElement(item.modelIcon)).toBe(true);
    if (
      !isValidElement<{ className?: string }>(item.agentIcon) ||
      !isValidElement<{ className?: string }>(item.modelIcon)
    ) {
      throw new Error("missing agent or model icon");
    }
    expect(item.agentIcon.props.className).toBe("text-text-1");
    expect(item.modelIcon.props.className).toBe("text-text-1");
  });
});

describe("truncateSessionOwnerLabel", () => {
  it("limits string owner names to 12 Unicode characters", () => {
    expect(truncateSessionOwnerLabel("abcdefghijklmnop")).toBe("abcdefghijkl…");
    expect(truncateSessionOwnerLabel("你好世界")).toBe("你好世界");
  });
});
