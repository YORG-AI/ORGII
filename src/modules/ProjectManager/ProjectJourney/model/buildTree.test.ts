import { describe, expect, it } from "vitest";

import { buildWorkspaceProjectTree } from "./buildTree";

describe("Project Journey tree", () => {
  it("contains sessions directly under projects and retains work item only as metadata", () => {
    const tree = buildWorkspaceProjectTree({
      projects: [{ id: "p", name: "项目" }],
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
});
