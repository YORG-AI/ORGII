/**
 * Session-sync coverage PER REPO SCOPE: how much of this device's history in
 * each of THIS ORG'S repos is published to it.
 *
 * The rows are the org's own repo scopes — not every repo on the device. Repo
 * scope is the hard boundary the push pass matches against, so a repo the org
 * has not scoped can never receive a session; listing it would report a 0%
 * that no user action can ever move. Sessions outside every org scope (and
 * sessions with no Git remote at all) are excluded from the rows AND from the
 * totals, so the headline percentage means "of the work this org can receive"
 * rather than "of everything on this laptop".
 *
 * Pure by design — the caller hands in the roster, the durable push markers,
 * and the scope resolver, so the same numbers are assertable in tests and
 * renderable from either sync surface (org-management → Sync, Runtime → org →
 * Sync).
 *
 * The DENOMINATOR reuses the engine's own candidate filters so no row can
 * exceed 100%:
 *  - `isPrimarySessionListSession` drops subagent/worker transcripts. A
 *    subagent is a rendering detail of its parent, never an independently
 *    published unit (see `importedSessionScopeMatch`), so counting one would
 *    inflate a denominator nothing can ever move.
 *  - `isCloudPushCandidate` drops teammate copies pulled DOWN from an org;
 *    those never round-trip back up.
 *  - `decidePushAdmission` applies fork provenance and the ownership/tag/
 *    explicit-share-intent gate.
 *  - `resolveCloudPushAccess` excludes admitted sessions whose effective
 *    access remains off.
 *
 * The NUMERATOR is the durable push marker — the same evidence
 * `Org2CloudSessionSyncState.wasCloudPushed` reads — so a session still counts
 * as synced after a restart. The in-memory metadata-hash cache is deliberately
 * NOT consulted: it dies with the app, and a count that shrinks on relaunch
 * reads as data loss.
 */
import type { Session } from "@src/store/session/sessionAtom/types";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import { normalizeRepoScopeKey } from "../TeamCollaboration/collabSyncUtils";
import { createSessionForkedFromResolver } from "../TeamCollaboration/forkSession";
import { peekMatchingOrgRepoScope } from "../TeamCollaboration/repoScopeResolver";
import {
  type SessionOrgTags,
  isSessionTaggedToCloudOrg,
} from "../TeamCollaboration/sessionOrgTagsAtom";
import {
  type CloudAccessSettingsByOrg,
  type CloudSharingFloorByOrg,
  hasExplicitCloudShareIntent,
  resolveCloudPushAccess,
} from "./org2CloudAccessSettings";
import { buildCloudOrgSelectorValue } from "./org2CloudOrgsAtom";
import { decidePushAdmission } from "./org2CloudPushAdmission";
import { isCloudPushCandidate } from "./org2CloudSessionSync.metadata";
import { getSessionScopeKeys } from "./org2CloudSyncEngine.repoScopeSync";

/** The roster fields coverage actually reads. */
export type SyncCoverageSession = Pick<
  Session,
  | "session_id"
  | "orgId"
  | "parentSessionId"
  | "orgMemberId"
  | "agentOrgId"
  | "importedFrom"
  | "repoPath"
  | "repoRemoteUrls"
  | "forkedFrom"
>;

export type SyncCoverageEligibilityResolver = (
  session: SyncCoverageSession
) => boolean;

export interface OrgSyncCoverageEligibilityState {
  orgId: string;
  tags: SessionOrgTags;
  accessByOrg: CloudAccessSettingsByOrg;
  floorByOrg: CloudSharingFloorByOrg;
}

/**
 * Which org repo scope a session syncs under.
 *  - `string` — the matched org scope; the session counts toward that row.
 *  - `null`   — outside every org scope (or no Git remote): not syncable to
 *               this org, so it is excluded from the rows and the totals.
 *  - `undefined` — a remote/identity lookup is still in flight; excluded for
 *               now and picked up on the resolver's next version bump.
 */
export type RepoScopeResolver = (
  session: SyncCoverageSession
) => string | null | undefined;

export interface RepoSyncCoverage {
  /** The org repo scope this row reports on. */
  repoScope: string;
  syncable: number;
  synced: number;
  /** 0–100, rounded. Always defined: a row exists only if it has sessions. */
  percent: number;
}

export interface SessionSyncCoverage {
  /** One entry per org repo scope that has syncable sessions, largest first. */
  repos: RepoSyncCoverage[];
  /** Totals across the rows — sessions this org can actually receive. */
  syncable: number;
  synced: number;
  /** 0–100, rounded. `null` when there is nothing syncable to divide by. */
  percent: number | null;
}

/** True for local sessions that count toward a coverage denominator. */
export function isSyncCoverageSession(session: SyncCoverageSession): boolean {
  return isPrimarySessionListSession(session) && isCloudPushCandidate(session);
}

/**
 * Replay the push engine's org-admission and effective-access gates for one
 * coverage snapshot. Repo matching remains a separate resolver because it
 * has an async/in-flight state; every other denominator rule lives here.
 */
export function createOrgSyncCoverageEligibilityResolver({
  orgId,
  tags,
  accessByOrg,
  floorByOrg,
}: OrgSyncCoverageEligibilityState): SyncCoverageEligibilityResolver {
  const settings = accessByOrg[orgId];
  const floor = floorByOrg[orgId];
  const forkedFromForSession = createSessionForkedFromResolver();
  return (session) => {
    if (!isSyncCoverageSession(session)) return false;
    const tagged = isSessionTaggedToCloudOrg(tags, session.session_id, orgId);
    const admission = decidePushAdmission({
      orgId,
      session,
      forkedFrom: forkedFromForSession(session),
      tagged,
      ownedByOrg: session.orgId === buildCloudOrgSelectorValue(orgId),
      shareIntent: hasExplicitCloudShareIntent(settings, session.session_id),
    });
    return (
      admission.admitted &&
      resolveCloudPushAccess(settings, session.session_id, tagged, floor) !==
        null
    );
  };
}

/**
 * Resolver that maps a session onto one of `orgScopes`, mirroring the push
 * pass's own matching (`getSessionScopeKeys` → `peekMatchingOrgRepoScope`):
 * multi-remote aware, and the MATCHED ORG-SIDE scope string is what comes
 * back — the same string the engine pushes as `repoScopeKey`, so a row is
 * labelled exactly as the org has it configured.
 *
 * Both lookups are cache-backed and self-priming, so cold calls return
 * `undefined` and warm the entries; pair this with
 * `useShareableScopeKeyVersion` so rows fill in as the lookups land.
 */
export function createOrgRepoScopeResolver(
  orgScopes: readonly string[] | undefined
): RepoScopeResolver {
  const normalized = (orgScopes ?? [])
    .map((scope) => normalizeRepoScopeKey(scope))
    .filter((scope) => scope.length > 0);
  if (normalized.length === 0) return () => null;
  return (session) => {
    const keys = getSessionScopeKeys(session);
    if (keys === undefined) return undefined;
    if (keys === null) return null;
    return peekMatchingOrgRepoScope(keys, normalized);
  };
}

/**
 * Session ids this device has durably published to `orgId`, read off the two
 * persisted marker maps. Mirrors `Org2CloudSessionSyncState.markedSessionIds`:
 * composite keys are `${orgId}:${sessionId}` and cloud org ids are uuids (no
 * colon), so the prefix cut stays exact even when a session id contains one.
 */
export function pushedSessionIdsForOrg(
  orgId: string,
  pushedMetadata: Readonly<Record<string, unknown>>,
  pushCursors: Readonly<Record<string, unknown>>
): Set<string> {
  const ids = new Set<string>();
  const prefix = `${orgId}:`;
  for (const source of [pushedMetadata, pushCursors]) {
    for (const key of Object.keys(source)) {
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
  }
  return ids;
}

export function computeSessionSyncCoverage(
  sessions: readonly SyncCoverageSession[],
  pushedSessionIds: ReadonlySet<string>,
  repoScopeForSession: RepoScopeResolver,
  isEligible: SyncCoverageEligibilityResolver = isSyncCoverageSession
): SessionSyncCoverage {
  const byScope = new Map<string, { syncable: number; synced: number }>();
  let syncable = 0;
  let synced = 0;

  for (const session of sessions) {
    if (!isEligible(session)) continue;
    // null = outside every org scope, undefined = lookup in flight. Neither
    // is work this org can receive today, so neither moves a number.
    const repoScope = repoScopeForSession(session);
    if (repoScope === null || repoScope === undefined) continue;

    // Markers for sessions that left the roster are ignored on purpose: the
    // engine's vanished-session GC retracts them, and counting them here
    // would report more synced than syncable.
    const isSynced = pushedSessionIds.has(session.session_id);
    syncable += 1;
    if (isSynced) synced += 1;

    const bucket = byScope.get(repoScope) ?? { syncable: 0, synced: 0 };
    bucket.syncable += 1;
    if (isSynced) bucket.synced += 1;
    byScope.set(repoScope, bucket);
  }

  const repos = [...byScope.entries()]
    .map(([repoScope, bucket]) => ({
      repoScope,
      syncable: bucket.syncable,
      synced: bucket.synced,
      percent: Math.round((bucket.synced / bucket.syncable) * 100),
    }))
    // Biggest repo first; the scope string breaks ties so the order never
    // churns between renders.
    .sort(
      (a, b) =>
        b.syncable - a.syncable || a.repoScope.localeCompare(b.repoScope)
    );

  return {
    repos,
    syncable,
    synced,
    percent: syncable === 0 ? null : Math.round((synced / syncable) * 100),
  };
}
