import { describe, expect, it } from "vitest";

import type { QuickAction } from "@src/api/http/project";

import {
  buildWorkItemQuickActionInvocation,
  quickActionToSlashItem,
  resolveWorkItemQuickActionScope,
} from "../workItemQuickActions";

function action(id: string, orgId = "org-1"): QuickAction {
  return {
    id,
    orgId,
    name: `Action ${id}`,
    description: "A saved action",
    targetKind: "agent",
    targetId: "builtin:sde",
    prompt: "  preserve me verbatim  ",
    useCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Work Item Quick Action slash scope", () => {
  it("requires both an explicit organization and Work Item id", () => {
    expect(resolveWorkItemQuickActionScope(null)).toBeNull();
    expect(
      resolveWorkItemQuickActionScope({
        orgId: "org-1",
        projectSlug: "demo",
        workItemId: undefined,
      })
    ).toBeNull();
    expect(
      resolveWorkItemQuickActionScope({
        orgId: undefined,
        projectSlug: "demo",
        workItemId: "DEMO-1",
      })
    ).toBeNull();
    expect(
      resolveWorkItemQuickActionScope({
        orgId: " org-1 ",
        projectSlug: undefined,
        workItemId: " DEMO-1 ",
      })
    ).toEqual({
      orgId: "org-1",
      projectSlug: null,
      workItemId: "DEMO-1",
    });
  });

  it("carries action and selected-scope identities without copying the prompt", () => {
    const scope = {
      orgId: "org-1",
      projectSlug: "demo",
      workItemId: "DEMO-1",
    };
    const item = quickActionToSlashItem(action("qa-1"), scope);
    expect(item).toMatchObject({
      name: "Action qa-1",
      category: "action",
      selection: {
        kind: "work_item_quick_action",
        actionId: "qa-1",
        orgId: "org-1",
      },
    });
    expect(item.selection?.scopeKey).toBeTruthy();
    expect(JSON.stringify(item)).not.toContain("preserve me verbatim");
  });

  it("builds an invocation only for the exact scope represented by the row", () => {
    const scope = {
      orgId: "org-1",
      projectSlug: "demo",
      workItemId: "DEMO-1",
    };
    const item = quickActionToSlashItem(action("qa-1"), scope);
    const actor = { actorId: "member-1", actorName: "Member One" };

    expect(buildWorkItemQuickActionInvocation(item, null, actor)).toBeNull();
    expect(
      buildWorkItemQuickActionInvocation(
        item,
        { ...scope, workItemId: "DEMO-2" },
        actor
      )
    ).toBeNull();
    expect(buildWorkItemQuickActionInvocation(item, scope, actor)).toEqual({
      ...scope,
      actionId: "qa-1",
      actorId: "member-1",
      actorName: "Member One",
    });
  });
});
