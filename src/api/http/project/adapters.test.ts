import { describe, expect, it } from "vitest";

import { standaloneWorkItemDataToEnriched } from "./adapters";
import type { LinkedSession, WorkItemData } from "./types";

function buildStandaloneItem(
  overrides: Partial<WorkItemData["frontmatter"]> = {}
): WorkItemData {
  return {
    frontmatter: {
      id: "T-1",
      short_id: "T-1",
      title: "Org surface work item",
      status: "planned",
      priority: "none",
      labels: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
      starred: false,
      todos: [],
      ...overrides,
    },
    body: "Item body",
    filename: "T-1.md",
  };
}

describe("standaloneWorkItemDataToEnriched", () => {
  it("maps the fields the collab org panel consumes", () => {
    const linkedSession: LinkedSession = {
      session_id: "session-1",
      session_type: "native",
      agent_role: "custom",
      started_at: "2026-07-01T00:00:00.000Z",
      status: "running",
      cost_usd: 0,
      total_tokens: 0,
      result_preview: "Plan",
    };
    const enriched = standaloneWorkItemDataToEnriched(
      buildStandaloneItem({
        assignee: "member-1",
        assignee_type: "human",
        linked_sessions: [linkedSession],
        execution_lock: { lockedByMemberId: "member-2" },
      })
    );

    expect(enriched.id).toBe("T-1");
    expect(enriched.shortId).toBe("T-1");
    expect(enriched.title).toBe("Org surface work item");
    expect(enriched.status).toBe("planned");
    expect(enriched.priority).toBe("none");
    // Standalone rows have no project — the panel renders the shortId.
    expect(enriched.project).toBeUndefined();
    // No member file to resolve against → raw id as the display name.
    expect(enriched.assignee).toEqual(
      expect.objectContaining({ id: "member-1", name: "member-1" })
    );
    expect(enriched.linkedSessions).toEqual([linkedSession]);
    expect(enriched.executionLock).toEqual(
      expect.objectContaining({ lockedByMemberId: "member-2" })
    );
    expect(enriched.deletedAt).toBeUndefined();
  });

  it("keeps deletedAt so soft-deleted rows can be filtered out", () => {
    const enriched = standaloneWorkItemDataToEnriched(
      buildStandaloneItem({ deleted_at: "2026-07-02T00:00:00.000Z" })
    );

    expect(enriched.deletedAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("defaults optional collections to empty arrays", () => {
    const enriched = standaloneWorkItemDataToEnriched(buildStandaloneItem());

    expect(enriched.labels).toEqual([]);
    expect(enriched.linkedSessions).toEqual([]);
    expect(enriched.comments).toEqual([]);
    expect(enriched.history).toEqual([]);
    expect(enriched.followUpItems).toEqual([]);
    expect(enriched.workProducts).toEqual([]);
    expect(enriched.assignee).toBeUndefined();
  });
});
