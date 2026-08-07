/**
 * Pure agent-task counter resolution for the sidebar's dual task chips
 * (agent-pickup design §4 UI item 6; migration 0002).
 *
 * The per-row listing counters — `openAgentTaskCount` /
 * `activeAgentTaskCount`, additive lateral aggregates on
 * `cloud_list_org_sessions` — are the PRIMARY source: they ride the same
 * fetch as the row and respect the listing's visibility predicate exactly.
 * Pre-0002 backends omit both keys; only then do the engine-fed
 * `org2CloudCommentTasksAtom` rows for the session act as the cross-scope
 * fallback, classified with the SAME predicate the server counters use:
 *
 * - open   = state 'open', OR claimed/running with an EXPIRED lease
 *            (reclaimable — needs attention);
 * - active = claimed/running with a live lease (an agent is working).
 *
 * done/failed are terminal and count toward neither chip.
 */
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type { CloudCommentTask } from "./org2CloudCommentTasksClient";

export interface SessionTaskCounts {
  /** Tasks awaiting pickup: open, or claimed/running past their lease. */
  open: number;
  /** Tasks an agent actively holds: claimed/running with a live lease. */
  active: number;
}

/**
 * Server counters when the row carries them (0002 backend sends BOTH;
 * either key present ⇒ trust the row, missing sibling reads as 0),
 * otherwise the atom-fed task rows for this session.
 */
export function resolveSessionTaskCounts(
  row: Pick<
    RemoteTeammateSessionMetadata,
    "openAgentTaskCount" | "activeAgentTaskCount"
  >,
  fallbackTasks: readonly CloudCommentTask[]
): SessionTaskCounts {
  if (
    row.openAgentTaskCount !== undefined ||
    row.activeAgentTaskCount !== undefined
  ) {
    return {
      open: row.openAgentTaskCount ?? 0,
      active: row.activeAgentTaskCount ?? 0,
    };
  }
  let open = 0;
  let active = 0;
  for (const task of fallbackTasks) {
    if (task.state === "open") {
      open += 1;
    } else if (task.state === "claimed" || task.state === "running") {
      if (task.leaseExpired) {
        open += 1;
      } else {
        active += 1;
      }
    }
  }
  return { open, active };
}
