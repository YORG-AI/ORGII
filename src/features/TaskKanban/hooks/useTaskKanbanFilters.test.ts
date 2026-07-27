import type { KanbanTask } from "@src/features/KanbanBoard";

import { KANBAN_AGENT_TYPE_FILTER } from "../config";
import { taskMatchesKanbanAgentTypeFilter } from "./useTaskKanbanFilters";

function task(agentTypeFilter?: string): KanbanTask {
  return {
    id: "session-1",
    title: "Session",
    status: "in_progress",
    agentTypeFilter,
  };
}

describe("taskMatchesKanbanAgentTypeFilter", () => {
  it("uses the canonical task projection for every Kanban mode", () => {
    expect(
      taskMatchesKanbanAgentTypeFilter(
        task(KANBAN_AGENT_TYPE_FILTER.CODEX_APP),
        KANBAN_AGENT_TYPE_FILTER.CODEX_APP
      )
    ).toBe(true);
    expect(
      taskMatchesKanbanAgentTypeFilter(
        task(KANBAN_AGENT_TYPE_FILTER.CODEX_APP),
        KANBAN_AGENT_TYPE_FILTER.CODEX_CLI
      )
    ).toBe(false);
  });

  it("keeps the all-agents filter independent of session provenance", () => {
    expect(
      taskMatchesKanbanAgentTypeFilter(task(), KANBAN_AGENT_TYPE_FILTER.ALL)
    ).toBe(true);
  });
});
