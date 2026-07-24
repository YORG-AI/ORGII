/**
 * GC for cloud session rows whose local session vanished.
 *
 * Every retract path in the engine's push pass only runs for sessions it
 * visits in `sessionsAtom`. A session can leave that roster without ever
 * being visited again — deleted locally, or an imported continuation sibling
 * demoted by the backend election — and its server row plus this device's
 * durable push markers would then linger forever: teammates keep a ghost row
 * in Team Conversations, and the owner's other devices list it as "another
 * device's session".
 *
 * Absence from `sessionsAtom` alone is WEAK evidence (the roster is
 * paginated), so every suspect is confirmed gone through the backend
 * exact-id lookup before it is eligible for retraction. That lookup also
 * reports continuation-superseded siblings as absent, which is what lets the
 * sweep clean up rows pushed for siblings that were later demoted.
 *
 * Only ids THIS device push-marked are ever candidates: rows the same
 * account pushed from another device carry no local marker and are never
 * touched. A failed lookup means "unknown", never "gone" — the sweep returns
 * nothing rather than risk retracting a live row.
 */
import { sessionAggregateList } from "@src/api/tauri/session";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("Org2CloudVanishedSessions");

/** Resolver used to confirm a suspect still exists somewhere locally. */
export type LocalSessionIdResolver = (
  sessionIds: readonly string[]
) => Promise<ReadonlySet<string>>;

/**
 * Default resolver: the aggregate exact-id lookup across every local store
 * (native sessions, agents, imported history). `includeExternalHistory` is
 * unconditional and no disabled-source filter is passed: a user hiding a
 * source from their sidebar must not cause its pushed cloud rows to be
 * treated as vanished.
 */
export const resolveLocalSessionIdsViaAggregateList: LocalSessionIdResolver =
  async (sessionIds) => {
    const response = await sessionAggregateList({
      sessionIds: [...sessionIds],
      includeExternalHistory: true,
      limit: sessionIds.length,
    });
    return new Set(response.sessions.map((record) => record.sessionId));
  };

interface FindVanishedPushedSessionIdsOptions {
  orgId: string;
  /** Ids this device durably marked as pushed to the org. */
  markedSessionIds: ReadonlySet<string>;
  /** Ids currently present in the loaded session roster. */
  liveSessionIds: ReadonlySet<string>;
  resolveSessionIds: LocalSessionIdResolver;
}

/**
 * Push-marked ids whose sessions no longer resolve anywhere locally, i.e.
 * safe candidates for cloud retraction. Returns an empty list when there are
 * no suspects or when the confirming lookup fails.
 */
export async function findVanishedPushedSessionIds({
  orgId,
  markedSessionIds,
  liveSessionIds,
  resolveSessionIds,
}: FindVanishedPushedSessionIdsOptions): Promise<string[]> {
  const suspects = [...markedSessionIds].filter(
    (sessionId) => !liveSessionIds.has(sessionId)
  );
  if (suspects.length === 0) return [];
  let resolved: ReadonlySet<string>;
  try {
    resolved = await resolveSessionIds(suspects);
  } catch (error) {
    // Unknown is not gone: without a confirmed lookup nothing may be
    // retracted, or a transient backend failure would delete live rows.
    log.warn(`vanished-session lookup failed for org ${orgId}:`, error);
    return [];
  }
  return suspects.filter((sessionId) => !resolved.has(sessionId));
}
