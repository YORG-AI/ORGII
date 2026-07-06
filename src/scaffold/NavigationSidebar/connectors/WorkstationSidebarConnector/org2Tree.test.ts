import { describe, expect, it } from "vitest";

import { buildOrg2TreeItems } from "./index";

describe("buildOrg2TreeItems", () => {
  it("按 workspace→project→task→session 归组，未关联项进入灰色未关联分组", () => {
    const tree = buildOrg2TreeItems([
      {
        session_id: "s1",
        name: "S1",
        projectSlug: "proj-a",
        workItemId: "T-1",
      },
      {
        session_id: "s2",
        name: "S2",
        projectSlug: "proj-a",
        workItemId: "T-2",
      },
      { session_id: "s3", name: "S3" },
    ] as never);
    const workspace = tree[0];
    expect(workspace.label).toBe("Workspace 层级树");
    const project = workspace.children?.find((item) => item.label === "proj-a");
    expect(project?.children?.map((item) => item.label)).toEqual([
      "T-1",
      "T-2",
    ]);
    expect(project?.children?.[0]?.children?.[0]?.label).toBe("S1");
    expect(project?.children?.[0]?.children?.[0]?.id).toBe("s1");
    const unlinked = workspace.children?.find(
      (item) => item.label === "未关联"
    );
    expect(unlinked?.children?.[0]?.label).toBe("未关联任务");
    expect(unlinked?.children?.[0]?.children?.[0]?.label).toBe("S3");
  });
});
