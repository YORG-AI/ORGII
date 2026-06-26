/**
 * Plan Approval Atom (non-blocking flow)
 *
 * Session-scoped pending-plan state consumed by `CreatePlanCard`. The
 * backend-authored plan revision id is matched against the card revision
 * to drive the Build button's enabled state.
 *
 *   current === null                            → no plan pending
 *   current.planRevisionId === myRevisionId     → this card's Build is live
 *   current.planRevisionId !== myRevisionId     → this card is archived / built
 *
 * Wire events that mutate this atom:
 *   - `agent:plan_ready_for_approval` → upsert into `current` (newer plan
 *     automatically supersedes the older one by replacing `current`)
 *   - `agent:exit_plan_mode`          → clear `current` (approved / discarded)
 *
 * `agent:plan_approval_archived` is **not** consumed by the frontend —
 * it fires in the same critical section as `plan_ready_for_approval`
 * (see `PlanApprovalManager::mark_ready`), and the upsert from the
 * paired `plan_ready_for_approval` already overwrites `current` with
 * the new snapshot. The older card's `idMatch` naturally flips to false.
 *
 * `cancel_active_turn` on the Rust side clears the pending snapshot
 * silently — no further events arrive, so the Build button simply stays
 * disabled (nothing to mark in FE state).
 */
import { atom } from "jotai";

export interface PendingPlanApproval {
  sessionId: string;
  planPath: string;
  planTitle: string;
  planContent: string;
  toolCallId?: string;
  planId?: string;
  planRevisionId?: string;
  originToolCallId?: string;
  autoApproveAt?: number | null;
}

export interface SessionPlanApprovalState {
  /** Currently pending plan for this session (null if none). */
  current: PendingPlanApproval | null;
}

export type PlanApprovalStateMap = Map<string, SessionPlanApprovalState>;

export const pendingPlanApprovalsAtom = atom<PlanApprovalStateMap>(new Map());

function emptyState(): SessionPlanApprovalState {
  return { current: null };
}

function normalizePlanCallId(value: string | undefined): string {
  if (!value) return "";
  return value.startsWith("tool-call-")
    ? value.slice("tool-call-".length)
    : value;
}

export function upsertPendingPlanApproval(
  prev: PlanApprovalStateMap,
  next: PendingPlanApproval
): PlanApprovalStateMap {
  const updated = new Map(prev);
  updated.set(next.sessionId, { current: next });
  return updated;
}

export function clearPendingPlanApproval(
  prev: PlanApprovalStateMap,
  sessionId: string,
  toolCallId?: string
): PlanApprovalStateMap {
  const existing = prev.get(sessionId);
  if (!existing || !existing.current) return prev;
  if (toolCallId) {
    const requestedId = normalizePlanCallId(toolCallId);
    const currentIds = new Set([
      normalizePlanCallId(existing.current.toolCallId),
      normalizePlanCallId(existing.current.planRevisionId),
      normalizePlanCallId(existing.current.originToolCallId),
    ]);
    if (!currentIds.has(requestedId)) return prev;
  }
  const updated = new Map(prev);
  updated.set(sessionId, emptyState());
  return updated;
}
