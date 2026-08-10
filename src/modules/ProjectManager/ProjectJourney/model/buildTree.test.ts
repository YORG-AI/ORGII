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

  it("projects only durable task and fork records, retaining the exact fork anchor", () => {
    const tree = buildWorkspaceProjectTree({
      projects: [{ id: "p", name: "项目" }],
      sessions: [{ session_id: "s", name: "规范会话", projectId: "p" }],
      workItemsByProject: {},
      journeysBySessionId: new Map([
        [
          "s",
          {
            state: "ready",
            snapshot: {
              tasks: {
                "task-1": {
                  id: "task-1",
                  name: "实现任务",
                  branch_id: "fork-1",
                  state: "active",
                  start_sequence: 8,
                  finish_sequence: null,
                  outcome: null,
                },
              },
              branches: {
                "fork-1": {
                  id: "fork-1",
                  parent_branch_id: "main",
                  parent_anchor_message_id: "message-7",
                  anchor_sequence: 7,
                  state: "active",
                },
              },
              checkpoints: {
                "checkpoint-1": {
                  id: "checkpoint-1",
                  task_id: "task-1",
                  message_id: "message-8",
                  sequence: 8,
                  name: "完成实现",
                },
              },
            },
          },
        ],
      ]),
    });

    const session = tree.children[0].children[0];
    expect(session.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task",
          taskId: "task-1",
          sessionId: "s",
          title: "实现任务",
        }),
        expect.objectContaining({
          kind: "fork",
          forkId: "fork-1",
          sessionId: "s",
          anchorMessageId: "message-7",
          anchorSequence: 7,
        }),
      ])
    );
    expect(session.children[0]?.children).toEqual([
      expect.objectContaining({
        kind: "checkpoint",
        anchorMessageId: "message-8",
      }),
    ]);
  });

  it("retains project-less canonical sessions under the visible unassigned section", () => {
    const tree = buildWorkspaceProjectTree({
      projects: [{ id: "p", name: "项目" }],
      sessions: [{ session_id: "unassigned", name: "无项目会话" }],
      workItemsByProject: {},
    });
    expect(tree.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unassigned",
          children: [expect.objectContaining({ sessionId: "unassigned" })],
        }),
      ])
    );
  });
});
