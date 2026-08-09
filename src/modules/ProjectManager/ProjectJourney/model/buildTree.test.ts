import { describe, expect, it } from "vitest";

import { buildWorkspaceProjectTree } from "./buildTree";

describe("Project Journey tree", () => {
  it("contains sessions directly under projects and retains work item only as metadata", () => {
    const tree = buildWorkspaceProjectTree({
      projects: [{ id: "p", name: "项目" }],
      sessions: [{ session_id: "s", name: "实现会话", projectId: "p" }],
      workItemsByProject: {
        p: [
          {
            session_id: "w",
            name: "工作项 A",
            linkedSessions: [{ session_id: "s", agent_role: "实现" }],
          },
        ],
      },
    });

    const [project] = tree.children;
    expect(project.kind).toBe("project");
    expect(project.children).toHaveLength(1);
    expect(project.children[0]).toMatchObject({
      kind: "session",
      sessionId: "s",
      workItemId: "w",
      meta: { workItemName: "工作项 A" },
    });
    expect(project.children.some((node) => node.kind === "work_item")).toBe(
      false
    );
  });

  it("uses canonical project sessions without work items and deduplicates linked metadata", () => {
    const tree = buildWorkspaceProjectTree({
      projects: [{ id: "p", name: "项目" }],
      sessions: [
        { session_id: "direct", name: "直接会话", projectId: "p" },
        { session_id: "linked", name: "规范会话", projectId: "p" },
      ],
      workItemsByProject: {
        p: [
          {
            session_id: "w",
            name: "工作项 A",
            linkedSessions: [{ session_id: "linked", agent_role: "实现" }],
          },
        ],
      },
    });

    const [project] = tree.children;
    expect(project.children).toHaveLength(2);
    expect(project.children.map((node) => node.sessionId)).toEqual([
      "direct",
      "linked",
    ]);
    expect(project.children[1]).toMatchObject({
      workItemId: "w",
      meta: { workItemName: "工作项 A" },
    });
    expect(project.children.some((node) => node.kind === "work_item")).toBe(
      false
    );
  });

  it("does not create a session node from a work item link absent from the canonical aggregate", () => {
    const tree = buildWorkspaceProjectTree({
      projects: [{ id: "p", name: "项目" }],
      sessions: [{ session_id: "canonical", name: "规范会话", projectId: "p" }],
      workItemsByProject: {
        p: [
          {
            session_id: "w",
            name: "工作项 A",
            linkedSessions: [{ session_id: "missing-from-aggregate" }],
          },
        ],
      },
    });

    expect(tree.children[0].children.map((node) => node.sessionId)).toEqual([
      "canonical",
    ]);
  });
});
