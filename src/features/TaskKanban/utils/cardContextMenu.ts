/**
 * Secondary-click (right-click) plan for a Kanban card.
 *
 * The board's primary click opens the floating session preview. The context
 * menu exposes the same target in either surface — the floating preview or a
 * new Chat Pane tab — so the decision of *which* actions a given card can
 * offer is kept here, away from the native-menu plumbing.
 */
import type { KanbanTask } from "@src/features/KanbanBoard";

export const KANBAN_CARD_CONTEXT_ACTION = {
  /** Open the board's own floating session-preview window (primary click). */
  OpenFloatingPane: "open-floating-pane",
  /** Open the session as its own Chat Pane tab, leaving the board open. */
  OpenInNewTabPane: "open-in-new-tab-pane",
} as const;

export type KanbanCardContextAction =
  (typeof KANBAN_CARD_CONTEXT_ACTION)[keyof typeof KANBAN_CARD_CONTEXT_ACTION];

export interface KanbanCardContextMenuPlan {
  /** Menu items to show, in display order. Empty means "show no menu". */
  actions: KanbanCardContextAction[];
  /** Local session id the new-tab action targets; `null` when unavailable. */
  sessionId: string | null;
}

export interface PlanKanbanCardContextMenuOptions {
  task: KanbanTask;
  /**
   * True for teammate cloud cards. Their transcript only exists after a remote
   * import that the board itself hosts — handing them to a Chat Pane tab
   * unmounts Work Management (and the import's abort controller with it), so
   * these cards only get the floating preview.
   */
  isRemoteTeamCard: boolean;
}

export function planKanbanCardContextMenu({
  task,
  isRemoteTeamCard,
}: PlanKanbanCardContextMenuOptions): KanbanCardContextMenuPlan {
  if (task.canOpen === false) {
    return { actions: [], sessionId: null };
  }

  const sessionId = task.session_id ?? null;
  const actions: KanbanCardContextAction[] = [
    KANBAN_CARD_CONTEXT_ACTION.OpenFloatingPane,
  ];
  if (!isRemoteTeamCard && sessionId) {
    actions.push(KANBAN_CARD_CONTEXT_ACTION.OpenInNewTabPane);
  }

  return { actions, sessionId };
}
