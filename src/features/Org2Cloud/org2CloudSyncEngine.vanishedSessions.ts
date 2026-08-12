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
 * exact-id lookup before it is eligible for retraction. The lookup runs with
 * `includeContinuationSuperseded`: a sibling demoted by the continuation
 * election still exists locally, and reporting it absent would retract the
 * team's shared cloud row on every context-window continuation (/compact).
 *
 * Only ids THIS device push-marked are ever candidates: rows the same
 * account pushed from another device carry no local marker and are never
 * touched. A failed lookup means "unknown", never "gone" — the sweep returns
 * nothing rather than risk retracting a live row. A successful-but-empty
 * lookup is still weak while the imported-history cache is rebuilding
 * (schema migration, cleared cache), so the ENGINE additionally requires a
 * suspect to be confirmed absent on two consecutive sweeps before
 * retracting.
 */
import {
  type ImportedContinuationStatus,
  importedHistoryContinuationStatuses,
} from "@src/api/tauri/externalHistory/imported/cloudReplay";
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
      includeContinuationSuperseded: true,
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

/** Resolver for continuation statuses of push-marked suspects. */
export type ContinuationStatusResolver = (
  sessionIds: readonly string[]
) => Promise<readonly ImportedContinuationStatus[]>;

export const resolveContinuationStatusesViaCache: ContinuationStatusResolver = (
  sessionIds
) => importedHistoryContinuationStatuses([...sessionIds]);

export interface SupersededPushedSession {
  sessionId: string;
  lineageId: string;
}

/**
 * Push-marked ids that left the roster because the continuation election
 * DEMOTED them — the imported cache still holds the row and reports a
 * strictly newer sibling. These are candidates for retracting the stale
 * Team Sessions duplicate, but ONLY the caller can confirm the family's
 * listable winner is itself pushed to the same org; without a lineage id
 * the winner cannot be identified and the row is left alone. A failed
 * lookup means "unknown", never "superseded".
 */
export async function findSupersededPushedSessions({
  orgId,
  markedSessionIds,
  liveSessionIds,
  resolveStatuses,
}: {
  orgId: string;
  markedSessionIds: ReadonlySet<string>;
  liveSessionIds: ReadonlySet<string>;
  resolveStatuses: ContinuationStatusResolver;
}): Promise<SupersededPushedSession[]> {
  return findSupersededSessions(
    orgId,
    [...markedSessionIds],
    liveSessionIds,
    resolveStatuses
  );
}

/**
 * Marker-FREE arm of the superseded reconcile. Push markers live in a
 * whole-map localStorage atom that every build sharing the bundle id
 * read-modify-writes (a concurrent process can clobber entries), and rows
 * pushed by the same account's OTHER device never had markers here — either
 * way the marker-driven arms go blind while the server row lives on. The
 * server listing is authoritative for "this account's rows in this org", so
 * self-owned live rows absent from the roster are judged by the same local
 * continuation election. The caller pre-filters to SELF-OWNED ids: rows
 * owned by other users must never reach this function.
 */
export async function findSupersededSelfOwnedRemoteSessions({
  orgId,
  remoteSelfSessionIds,
  liveSessionIds,
  resolveStatuses,
}: {
  orgId: string;
  remoteSelfSessionIds: readonly string[];
  liveSessionIds: ReadonlySet<string>;
  resolveStatuses: ContinuationStatusResolver;
}): Promise<SupersededPushedSession[]> {
  return findSupersededSessions(
    orgId,
    remoteSelfSessionIds,
    liveSessionIds,
    resolveStatuses
  );
}

async function findSupersededSessions(
  orgId: string,
  candidateSessionIds: readonly string[],
  liveSessionIds: ReadonlySet<string>,
  resolveStatuses: ContinuationStatusResolver
): Promise<SupersededPushedSession[]> {
  const suspects = candidateSessionIds.filter(
    (sessionId) => !liveSessionIds.has(sessionId)
  );
  if (suspects.length === 0) return [];
  let statuses: readonly ImportedContinuationStatus[];
  try {
    statuses = await resolveStatuses(suspects);
  } catch (error) {
    log.warn(`continuation-status lookup failed for org ${orgId}:`, error);
    return [];
  }
  return statuses
    .filter((status) => status.superseded && status.lineageId)
    .map((status) => ({
      sessionId: status.sessionId,
      lineageId: status.lineageId as string,
    }));
}
