import type { KanbanTask } from "@src/features/KanbanBoard";

import {
  buildTaskSessionNameSearchText,
  normalizeKanbanSearchQuery,
} from "./useTaskKanbanFilters";

function task(title: string): KanbanTask {
  return {
    id: "session-1",
    title,
    status: "in_progress",
    impact: {
      filesChanged: 1,
      linesAdded: 0,
      linesRemoved: 0,
      relatedCommits: 0,
      committedFiles: 0,
      committedRatePercent: 0,
      touchedFiles: ["src/features/metadata/SessionRoundMetadata.tsx"],
    },
  };
}

describe("Kanban session-name search", () => {
  it("matches a partial session name case-insensitively", () => {
    const text = buildTaskSessionNameSearchText(
      task("Update Session Metadata")
    );

    expect(text.includes(normalizeKanbanSearchQuery("SESSION meta"))).toBe(
      true
    );
  });

  it("trims the query before matching", () => {
    const text = buildTaskSessionNameSearchText(task("Fix kanban search"));

    expect(text.includes(normalizeKanbanSearchQuery("  kanban  "))).toBe(true);
    expect(normalizeKanbanSearchQuery("   ")).toBe("");
  });

  it("does not include touched-file paths in the search text", () => {
    const text = buildTaskSessionNameSearchText(task("Unrelated session"));

    expect(
      text.includes(normalizeKanbanSearchQuery("SessionRoundMetadata"))
    ).toBe(false);
  });
});
