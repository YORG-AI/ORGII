import type { KanbanTask } from "@src/features/KanbanBoard";

import {
  KANBAN_CARD_CONTEXT_ACTION,
  planKanbanCardContextMenu,
} from "./cardContextMenu";

function task(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    title: overrides.id,
    status: "turn_finished",
    ...overrides,
  } as KanbanTask;
}

describe("planKanbanCardContextMenu", () => {
  it("offers both surfaces for a local session card", () => {
    const plan = planKanbanCardContextMenu({
      task: task({ id: "claude-1", session_id: "claude-1" }),
      isRemoteTeamCard: false,
    });
    expect(plan.actions).toEqual([
      KANBAN_CARD_CONTEXT_ACTION.OpenFloatingPane,
      KANBAN_CARD_CONTEXT_ACTION.OpenInNewTabPane,
    ]);
    expect(plan.sessionId).toBe("claude-1");
  });

  it("keeps a teammate cloud card on the floating preview only", () => {
    // Its remote import is hosted by the board; a Chat Pane tab would unmount
    // Work Management mid-import and leave the new tab empty.
    const plan = planKanbanCardContextMenu({
      task: task({ id: "cloud-remote:row-1" }),
      isRemoteTeamCard: true,
    });
    expect(plan.actions).toEqual([KANBAN_CARD_CONTEXT_ACTION.OpenFloatingPane]);
  });

  it("omits the new-tab action for a card with no local session", () => {
    const plan = planKanbanCardContextMenu({
      task: task({ id: "todo-1" }),
      isRemoteTeamCard: false,
    });
    expect(plan.actions).toEqual([KANBAN_CARD_CONTEXT_ACTION.OpenFloatingPane]);
    expect(plan.sessionId).toBeNull();
  });

  it("shows no menu for a card that cannot be opened", () => {
    const plan = planKanbanCardContextMenu({
      task: task({ id: "cloud-remote:row-2", canOpen: false }),
      isRemoteTeamCard: true,
    });
    expect(plan.actions).toEqual([]);
  });
});
