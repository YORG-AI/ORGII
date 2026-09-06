import { describe, expect, it } from "vitest";

import {
  normalizeWorkItemStatus,
  projectDataToUI,
  standaloneWorkItemDataToEnriched,
  uiWorkItemToFrontmatter,
  workItemCommentToEntry,
} from "./adapters";
import type {
  LinkedSession,
  ProjectData,
  WorkItemData,
  WorkItemOriginSession,
} from "./types";

function buildProjectData(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    meta: {
      id: "project-1",
      name: "GitHub Project",
      org_id: "personal-org",
      status: "backlog",
      priority: "none",
      health: "no_updates",
      members: [],
      labels: [],
      linked_repos: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
      next_work_item_id: 1,
      work_item_prefix: "GIT",
      work_item_prefix_custom: false,
    },
    description: "Synced GitHub issues",
    slug: "github-project",
    ...overrides,
  };
}

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
    const originSession: WorkItemOriginSession = {
      session_id: "creator-session",
      provider: "org2",
      actor_id: "agent:sde",
      session_type: "native",
      captured_at: "2026-07-01T00:00:00.000Z",
    };
    const enriched = standaloneWorkItemDataToEnriched(
      buildStandaloneItem({
        assignee: "member-1",
        assignee_type: "human",
        linked_sessions: [linkedSession],
        origin_session: originSession,
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
    expect(enriched.originSession).toEqual(originSession);
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

describe("projectDataToUI", () => {
  it("preserves the sync adapter identity without requiring connection data", () => {
    const project = projectDataToUI(
      buildProjectData({ sync_adapter_id: "github" }),
      { labelMap: new Map(), memberMap: new Map() }
    );

    expect(project.syncAdapterId).toBe("github");
    expect(project).not.toHaveProperty("syncConnectionId");
  });
});

describe("normalizeWorkItemStatus", () => {
  it("preserves custom and blocked status identities", () => {
    expect(normalizeWorkItemStatus("waiting_external")).toBe(
      "waiting_external"
    );
    expect(normalizeWorkItemStatus("blocked")).toBe("blocked");
  });

  it("uses backlog only when no status exists", () => {
    expect(normalizeWorkItemStatus(undefined)).toBe("backlog");
  });
});

describe("workItemCommentToEntry", () => {
  it("preserves the complete per-comment identity and revision payload", () => {
    const comment = {
      id: "comment-1",
      author: "member-1",
      content: "Updated body",
      created_at: "2026-08-19T10:00:00.000Z",
      revision: 3,
      mentioned_user_ids: ["member-2"],
      mentions: [{ kind: "member" as const, id: "member-2" }],
      parent_id: "comment-parent",
      thread_id: "thread-1",
      resolved_at: "2026-08-19T10:05:00.000Z",
      resolved_by: "member-3",
      conclusion: true,
      agent_session_id: "session-1",
      edited_at: "2026-08-19T10:03:00.000Z",
      deleted_at: "2026-08-19T10:06:00.000Z",
    };

    expect(workItemCommentToEntry(comment)).toEqual(comment);
  });
});

describe("uiWorkItemToFrontmatter custom statuses", () => {
  it("keeps a custom status key on the outbound frontmatter instead of dropping it", () => {
    const frontmatter = uiWorkItemToFrontmatter(
      {
        session_id: "wi-1",
        name: "Custom status item",
        workItemStatus: "code-review" as never,
        priority: "none",
      } as never,
      undefined as never
    );
    expect(frontmatter.status).toBe("code-review");
  });

  it("still maps built-in statuses through the file vocabulary", () => {
    const frontmatter = uiWorkItemToFrontmatter(
      {
        session_id: "wi-2",
        name: "Builtin status item",
        workItemStatus: "in_progress",
        priority: "none",
      } as never,
      undefined as never
    );
    expect(frontmatter.status).toBe("in_progress");
  });
});
