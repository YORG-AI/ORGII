import { describe, expect, it } from "vitest";

import type { KanbanTask } from "@src/features/KanbanBoard";

import {
  buildTaskFileSearchText,
  normalizeFileSearchQuery,
} from "./useTaskKanbanFilters";

function task(paths: string[]): KanbanTask {
  return {
    id: "session-1",
    title: "Metadata feature",
    status: "in_progress",
    impact: {
      filesChanged: paths.length,
      linesAdded: 0,
      linesRemoved: 0,
      relatedCommits: 0,
      committedFiles: 0,
      committedRatePercent: 0,
      touchedFiles: paths,
    },
  };
}

describe("Kanban file metadata search", () => {
  it("matches a basename fragment", () => {
    const text = buildTaskFileSearchText(
      task(["src/engines/ChatPanel/TurnMetadataFooter.tsx"])
    );
    expect(text.includes(normalizeFileSearchQuery("metadatafooter"))).toBe(
      true
    );
  });

  it("matches a partial directory path case-insensitively", () => {
    const text = buildTaskFileSearchText(
      task(["src/features/TaskKanban/hooks/useTaskKanbanFilters.ts"])
    );
    expect(text.includes(normalizeFileSearchQuery("TASKKANBAN/HOOKS"))).toBe(
      true
    );
  });

  it("normalizes Windows separators and empty queries", () => {
    const text = buildTaskFileSearchText(task(["src\\core\\session.rs"]));
    expect(text.includes(normalizeFileSearchQuery("core/session"))).toBe(true);
    expect(normalizeFileSearchQuery("   ")).toBe("");
  });
});
