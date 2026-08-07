/**
 * Per-org comment agent-task map (in-memory only; migration 0002, design
 * session-comments-agent-pickup-design-0707 §4).
 *
 * Maps cloud orgId → { taskId → `comment_task_wire` row } — keyed by ORG,
 * not org|session, because the sync engine pulls `cloud_list_comment_tasks`
 * deltas per org (Phase 5 wires that pull; this module owns only the state
 * and its pure transforms). NOT persisted: task visibility mirrors the
 * session-listing predicate server-side (member + retention window +
 * restricted grants), so cached rows go stale and the engine's full listing
 * on start rebuilds the map anyway. Rows here can NEVER carry a lease token
 * — structurally, not by discipline: `CloudCommentTaskWireSchema` strips
 * unknown keys and no listing wire includes it (0002 invariant 1).
 *
 * Readers: the sidebar's dual task chips use this map as the cross-scope
 * fallback next to the per-row listing counters. The thread UI instead
 * reads its tasks off the comments atom (same-fetch `tasks` embed), so no
 * fetch hook lives here.
 */
import { atom } from "jotai";

import type { CloudCommentTask } from "./org2CloudCommentTasksClient";

/** One org's tasks, keyed by task id (`comment_task_wire.id`). */
export type CloudCommentTaskMap = Record<string, CloudCommentTask>;

/** Cloud orgId → task map (the engine merges one org at a time). */
export type CloudCommentTasksByOrg = Record<string, CloudCommentTaskMap>;

export const org2CloudCommentTasksAtom = atom<CloudCommentTasksByOrg>({});
org2CloudCommentTasksAtom.debugLabel = "org2CloudCommentTasksAtom";

// ---------------------------------------------------------------------------
// Pure transforms (unit-tested; no IO)
// ---------------------------------------------------------------------------

/**
 * Strict `updatedAt` recency, numeric (Date.parse) — Postgres renders
 * timestamptz with trimmed fractional seconds ("…T12:00:00+00:00" next to
 * "…T12:00:00.5+00:00"), so a lexicographic comparison would mis-order
 * rows across that boundary. Malformed input (unreachable on wire-parsed
 * rows) degrades to the comments atom's lexicographic ordering rather
 * than throwing. Exported: the comments atom's engine-poll reconciliation
 * compares the same server timestamps with the same discipline.
 */
export function isNewerTaskUpdate(
  candidate: string,
  baseline: string
): boolean {
  const candidateMs = Date.parse(candidate);
  const baselineMs = Date.parse(baseline);
  if (Number.isNaN(candidateMs) || Number.isNaN(baselineMs)) {
    return candidate > baseline;
  }
  return candidateMs > baselineMs;
}

/**
 * `updated_at` last-write-wins merge of one org's delta rows into its map.
 *
 * - A row the map holds a STRICTLY newer copy of is discarded: the 2s
 *   cursor-overlap re-delivers already-seen rows, and an older re-delivery
 *   must never clobber a fresher local write-through (e.g. a claim/create
 *   response stored between engine passes).
 * - Ties go to the INCOMING row — the server is truth, and the overlap
 *   re-delivers equal timestamps for at most a pass or two.
 * - Pure and identity-stable: inputs are never mutated, untouched rows
 *   keep their object identity, and the SAME `existing` reference comes
 *   back when nothing changed — the engine's 60s pass must not churn the
 *   atom on empty deltas.
 *
 * Cascade-deleted rows (session hard-delete, thread-head delete) simply
 * stop appearing in deltas and linger until the engine's next full-listing
 * rebuild (`mergeCommentTasks({}, tasks)`, once per engine start) or app
 * restart — acceptable for a fallback counter source; the per-row listing
 * counters stay primary.
 */
export function mergeCommentTasks(
  existing: CloudCommentTaskMap,
  incoming: readonly CloudCommentTask[]
): CloudCommentTaskMap {
  if (incoming.length === 0) return existing;
  let changed = false;
  const merged: CloudCommentTaskMap = { ...existing };
  for (const task of incoming) {
    const current = merged[task.id];
    if (current && isNewerTaskUpdate(current.updatedAt, task.updatedAt)) {
      continue;
    }
    merged[task.id] = task;
    changed = true;
  }
  return changed ? merged : existing;
}

function compareTasks(left: CloudCommentTask, right: CloudCommentTask): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  // Deterministic tiebreak — the comments atom's (createdAt, id) idiom.
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * All tasks for one session, (createdAt, id) asc for a deterministic
 * render. Scoped by org FIRST — session ids are locally-generated text
 * (`agentsession-*`) and may collide across orgs.
 */
export function tasksForSession(
  map: CloudCommentTasksByOrg,
  orgId: string,
  sessionId: string
): CloudCommentTask[] {
  const orgTasks = map[orgId];
  if (!orgTasks) return [];
  return Object.values(orgTasks)
    .filter((task) => task.sessionId === sessionId)
    .sort(compareTasks);
}

/**
 * The task promoted from a thread head — unique per comment, ever (0002
 * UNIQUE `comment_id`). Comment ids are server-minted uuids, globally
 * unique, so the scan safely crosses org boundaries.
 */
export function taskForComment(
  map: CloudCommentTasksByOrg,
  commentId: string
): CloudCommentTask | undefined {
  for (const orgTasks of Object.values(map)) {
    for (const task of Object.values(orgTasks)) {
      if (task.commentId === commentId) return task;
    }
  }
  return undefined;
}
