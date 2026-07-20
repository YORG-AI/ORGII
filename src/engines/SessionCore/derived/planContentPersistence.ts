/**
 * Plan-content persistence (issue #28 — Save decoupled from Build).
 *
 * "Save" on a pending plan must persist the edited markdown WITHOUT approving
 * or executing the plan. Persistence has to reach every surface that later
 * re-reads the plan so the edit is visible on re-view:
 *
 *   1. The plan markdown FILE at `planPath` — the durable source the backend
 *      Build turn reads (`std::fs::read_to_string`) and the one "Open in My
 *      Station" opens. Writing it means a later plain `approve` Build executes
 *      the edited plan, and the on-disk doc reflects the edit immediately.
 *   2. The plan `SessionEvent`(s) in the Rust-backed event store — the source
 *      the in-app preview (Agent Station `PlanDocPanel`) and the chat
 *      `CreatePlanCard` render from (`args.streamContent` / `args.content`).
 *      Patching these makes the edit visible on re-view within the session.
 *   3. The `pendingPlanApprovalsAtom` snapshot's `planContent` — the source of
 *      the synthesized pending-plan message and other snapshot-derived reads.
 *
 * The pure helpers below (alias matching, arg merge, snapshot update) are unit
 * tested; the async orchestrator takes injected IO so it stays testable too.
 */
import type {
  PendingPlanApproval,
  PlanApprovalStateMap,
} from "@src/store/session/planApprovalAtom";

import type { SessionEvent } from "../core/types";
import {
  getPlanEventAliases,
  isPlanDisplayEvent,
  pendingPlanMatchesEvent,
} from "./planDisplayEvents";

function asPlanString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Merge edited markdown into a plan event's `args` without dropping identity
 * fields (title / planPath / planId / revision ids). Both `content` and
 * `streamContent` are set because the preview prefers `streamContent` when
 * present (`streamContent || content`).
 */
/**
 * Resolve the markdown a plan surface should render.
 *
 * After Save, `pendingPlanApprovalsAtom.planContent` is updated synchronously
 * while the chat transcript may still hold a stale event reference (derived
 * snapshot lag / `chatEventsAtom` stability cache). Prefer the pending
 * snapshot when the event matches the active approval so every surface agrees
 * immediately after Save from either the chat card or Agent Station preview.
 */
export function resolvePlanMarkdownContent(
  event: SessionEvent,
  pendingPlan: PendingPlanApproval | null | undefined
): string {
  if (pendingPlan && pendingPlanMatchesEvent(pendingPlan, event)) {
    return pendingPlan.planContent;
  }
  const args = event.args as Record<string, unknown> | undefined;
  const result = event.result as Record<string, unknown> | undefined;
  return (
    asPlanString(args?.streamContent) ||
    asPlanString(args?.content) ||
    asPlanString(result?.content)
  );
}

export function applyEditedContentToPlanArgs(
  args: unknown,
  content: string
): Record<string, unknown> {
  const base =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return { ...base, content, streamContent: content };
}

export interface PlanContentPatch {
  id: string;
  args: Record<string, unknown>;
}

/**
 * Build the per-event arg patches for every plan display event whose aliases
 * intersect the pending plan's aliases. Each patch carries the full merged
 * `args` because the Rust event patch replaces (not deep-merges) `args`.
 */
export function buildPlanContentPatches(
  events: readonly SessionEvent[],
  pendingAliases: readonly string[],
  content: string
): PlanContentPatch[] {
  if (pendingAliases.length === 0) return [];
  const aliasSet = new Set(pendingAliases);
  const patches: PlanContentPatch[] = [];
  for (const event of events) {
    if (!isPlanDisplayEvent(event)) continue;
    const aliases = getPlanEventAliases(event);
    if (!aliases.some((alias) => aliasSet.has(alias))) continue;
    patches.push({
      id: event.id,
      args: applyEditedContentToPlanArgs(event.args, content),
    });
  }
  return patches;
}

/**
 * Immutably update the pending plan snapshot's `planContent` for a session.
 * No-op (returns the same map) when nothing is pending for that session.
 */
export function updatePendingPlanContent(
  prev: PlanApprovalStateMap,
  sessionId: string,
  content: string
): PlanApprovalStateMap {
  const existing = prev.get(sessionId);
  if (!existing?.current) return prev;
  if (existing.current.planContent === content) return prev;
  const updated = new Map(prev);
  updated.set(sessionId, {
    ...existing,
    current: { ...existing.current, planContent: content },
  });
  return updated;
}

export interface PersistPlanEditIO {
  /** Atomically update the backend pending snapshot and its backing plan file. */
  persistPendingContent: (
    sessionId: string,
    content: string,
    planRevisionId?: string
  ) => Promise<unknown>;
  /** Read the current events for a session from the event store. */
  getEvents: (sessionId: string) => Promise<SessionEvent[]>;
  /** Patch a single event's args in the event store. */
  patchEvent: (
    id: string,
    args: Record<string, unknown>,
    sessionId: string
  ) => Promise<unknown>;
  /** Optional best-effort flush of the patched events to the SQLite cache. */
  saveCache?: (sessionId: string) => Promise<unknown>;
}

/**
 * Persist an edited plan WITHOUT approving it: write the plan file, patch the
 * plan event(s) the preview re-reads, and (optionally) flush to cache. The
 * caller is responsible for updating the snapshot atom and exiting edit mode.
 */
export async function persistEditedPlanContent(params: {
  sessionId: string;
  planRevisionId?: string;
  pendingAliases: readonly string[];
  content: string;
  io: PersistPlanEditIO;
}): Promise<void> {
  const { sessionId, planRevisionId, pendingAliases, content, io } = params;

  await io.persistPendingContent(sessionId, content, planRevisionId);

  const events = await io.getEvents(sessionId);
  const patches = buildPlanContentPatches(events, pendingAliases, content);
  for (const patch of patches) {
    await io.patchEvent(patch.id, patch.args, sessionId);
  }

  if (patches.length > 0 && io.saveCache) {
    try {
      await io.saveCache(sessionId);
    } catch {
      // Cache flush is a durability nicety, not required for the in-session
      // re-view; the in-memory event store patch already reflects the edit.
    }
  }
}
