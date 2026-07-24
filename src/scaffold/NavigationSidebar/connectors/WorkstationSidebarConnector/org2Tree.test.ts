import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session";

import { buildOrg2TreeItems } from "./index";

function session(overrides: Partial<Session>): Session {
  return {
    session_id: "s1",
    status: "running",
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
    projectSlug: "project-a",
    workItemId: "TASK-1",
    name: "Implement deterministic graph",
    ...overrides,
  } as Session;
}

describe("buildOrg2TreeItems", () => {
  it("builds the exact Workspace → Project → Session → Task hierarchy", () => {
    const [workspace] = buildOrg2TreeItems([session({})]);
    const project = workspace.children?.[0];
    const sessionRow = project?.children?.[0];
    const task = sessionRow?.children?.[0];
    expect([
      workspace.shortcut,
      project?.shortcut,
      sessionRow?.shortcut,
      task?.shortcut,
    ]).toEqual(["1 projects", "1 sessions", "session", "task"]);
    expect(sessionRow?.id).toBe("s1");
    expect(task?.label).toBe("TASK-1");
  });

  it("keeps unlinked sessions visible under explicit fallback nodes", () => {
    const [workspace] = buildOrg2TreeItems([
      session({
        projectSlug: undefined,
        projectId: undefined,
        workItemId: undefined,
      }),
    ]);
    expect(workspace.children?.[0]?.label).toBe("Unlinked");
    expect(workspace.children?.[0]?.children?.[0]?.children?.[0]).toMatchObject(
      {
        label: "Unlinked task",
        shortcut: "unlinked",
        disabled: true,
      }
    );
  });
});
