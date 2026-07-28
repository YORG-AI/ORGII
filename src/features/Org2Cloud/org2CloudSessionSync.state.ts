/**
 * In-memory push-state bookkeeping for Org2CloudSessionSync: pushed-metadata
 * hashes, clean-event-plane stamps, cold-start seed dedup, per-pass push
 * preparation caching, and the persisted cursor / pushed-metadata-marker
 * atoms. Holds no sync client and makes no cloud calls; the concrete
 * Org2CloudSessionSync subclass in org2CloudSessionSync.ts adds the
 * network-facing push/rewrite orchestration on top of this state.
 */
import type { Session } from "@src/store/session/sessionAtom/types";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import { sha256Hex } from "../TeamCollaboration/collabSyncUtils";
import type {
  CleanEventPlaneStamp,
  ExternalHistoryVersionObservation,
  PreparedPushEvents,
} from "./org2CloudSessionSync.types";
import type { CollabSessionPushCursor } from "./org2CloudSyncAtoms";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
} from "./org2CloudSyncAtoms";
import {
  type CloudStore,
  EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS,
} from "./org2CloudSyncLifecycle";

/** Safety TTL for rechecking a session whose events plane was verified clean. */
const EVENTS_CLEAN_TTL_MS = 10 * 60_000;

export class Org2CloudSessionSyncState {
  /** `${orgId}:${sessionId}` to hash of the last upserted metadata. */
  protected readonly lastPushedMetadataHashes = new Map<string, string>();
  /** sessionId to orgId to time when the event plane was verified clean. */
  protected readonly cleanEventPlanes = new Map<
    string,
    Map<string, CleanEventPlaneStamp>
  >();
  /** A cold-start remote summary may seed each (org, session) only once. */
  protected readonly remoteSeedAttemptedKeys = new Set<string>();
  /** Session activity stamp prevents a mid-push write from being marked clean. */
  protected readonly eventActivityStamps = new Map<string, number>();
  /** Last write time for quiet-window gating of mutable external histories. */
  private readonly eventActivityAtMs = new Map<string, number>();
  /** Last imported-source version observed from sessionsAtom. */
  private readonly externalHistoryVersions = new Map<
    string,
    ExternalHistoryVersionObservation
  >();
  /** Org-independent event reads and hashing shared across orgs in one pass. */
  protected readonly passPushPrepareCache = new Map<
    string,
    Promise<PreparedPushEvents>
  >();

  constructor(protected readonly getStore: () => CloudStore | null) {}

  reset(): void {
    this.lastPushedMetadataHashes.clear();
    this.cleanEventPlanes.clear();
    this.eventActivityStamps.clear();
    this.eventActivityAtMs.clear();
    this.externalHistoryVersions.clear();
    this.passPushPrepareCache.clear();
    this.remoteSeedAttemptedKeys.clear();
  }

  /** Start a new engine pass; prepared events must never leak across passes. */
  beginPass(): void {
    this.passPushPrepareCache.clear();
  }

  /**
   * Keep app-lifetime acceleration state inside the currently reachable data
   * set. Durable cursors/markers remain in Jotai storage until their own
   * retraction/reconcile paths run; these in-memory hashes and clean stamps are
   * only caches, so dropping a dead key can at worst cause one safe recheck.
   */
  prune(
    liveOrgIds: ReadonlySet<string>,
    liveSessionIds: ReadonlySet<string>
  ): void {
    for (const key of this.lastPushedMetadataHashes.keys()) {
      const separatorIndex = key.indexOf(":");
      const orgId = separatorIndex === -1 ? key : key.slice(0, separatorIndex);
      const sessionId =
        separatorIndex === -1 ? "" : key.slice(separatorIndex + 1);
      if (!liveOrgIds.has(orgId) || !liveSessionIds.has(sessionId)) {
        this.lastPushedMetadataHashes.delete(key);
      }
    }
    for (const key of this.remoteSeedAttemptedKeys) {
      const separatorIndex = key.indexOf(":");
      const orgId = separatorIndex === -1 ? key : key.slice(0, separatorIndex);
      const sessionId =
        separatorIndex === -1 ? "" : key.slice(separatorIndex + 1);
      if (!liveOrgIds.has(orgId) || !liveSessionIds.has(sessionId)) {
        this.remoteSeedAttemptedKeys.delete(key);
      }
    }
    for (const [sessionId, byOrg] of this.cleanEventPlanes) {
      if (!liveSessionIds.has(sessionId)) {
        this.cleanEventPlanes.delete(sessionId);
        continue;
      }
      for (const orgId of byOrg.keys()) {
        if (!liveOrgIds.has(orgId)) byOrg.delete(orgId);
      }
      if (byOrg.size === 0) this.cleanEventPlanes.delete(sessionId);
    }
    for (const sessionId of this.eventActivityStamps.keys()) {
      if (!liveSessionIds.has(sessionId)) {
        this.eventActivityStamps.delete(sessionId);
      }
    }
    for (const sessionId of this.eventActivityAtMs.keys()) {
      if (!liveSessionIds.has(sessionId)) {
        this.eventActivityAtMs.delete(sessionId);
      }
    }
    for (const sessionId of this.externalHistoryVersions.keys()) {
      if (!liveSessionIds.has(sessionId)) {
        this.externalHistoryVersions.delete(sessionId);
      }
    }
  }

  /** Drop clean markers and stamp a local event-store write. */
  noteSessionEventActivity(sessionId: string): void {
    this.eventActivityStamps.set(
      sessionId,
      (this.eventActivityStamps.get(sessionId) ?? 0) + 1
    );
    this.eventActivityAtMs.set(sessionId, Date.now());
    this.cleanEventPlanes.delete(sessionId);
  }

  /**
   * Imported CLI files are mutable snapshots, not append-only EventStore
   * streams. During a live turn older normalized records can still change;
   * wait for the same quiet window as the lifecycle timer before doing the
   * expensive full read/normalize/rewrite. Metadata remains live.
   */
  protected isExternalHistorySettled(session: Session): boolean {
    const sessionId = session.session_id;
    if (!isImportedHistorySession(sessionId)) return true;
    const now = Date.now();
    const observed = this.externalHistoryVersions.get(sessionId);
    if (!observed || observed.sourceUpdatedAt !== session.updated_at) {
      this.externalHistoryVersions.set(sessionId, {
        sourceUpdatedAt: session.updated_at,
        observedAt: now,
      });
      return false;
    }
    const changedAt = Math.max(
      observed.observedAt,
      this.eventActivityAtMs.get(sessionId) ?? 0
    );
    return now - changedAt >= EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS;
  }

  protected isEventPlaneClean(orgId: string, session: Session): boolean {
    const clean = this.cleanEventPlanes.get(session.session_id)?.get(orgId);
    if (!clean || Date.now() - clean.verifiedAt >= EVENTS_CLEAN_TTL_MS) {
      return false;
    }
    return (
      !isImportedHistorySession(session.session_id) ||
      clean.sourceUpdatedAt === session.updated_at
    );
  }

  protected markEventPlaneClean(
    orgId: string,
    session: Session,
    stampAtRead: number,
    verifiedAt = Date.now()
  ): void {
    const sessionId = session.session_id;
    if ((this.eventActivityStamps.get(sessionId) ?? 0) !== stampAtRead) return;
    let byOrg = this.cleanEventPlanes.get(sessionId);
    if (!byOrg) {
      byOrg = new Map();
      this.cleanEventPlanes.set(sessionId, byOrg);
    }
    byOrg.set(orgId, {
      verifiedAt,
      sourceUpdatedAt: isImportedHistorySession(sessionId)
        ? session.updated_at
        : undefined,
    });
  }

  protected getCursor(
    orgId: string,
    sessionId: string
  ): CollabSessionPushCursor | undefined {
    return this.getStore()?.get(org2CloudPushCursorsAtom)[
      `${orgId}:${sessionId}`
    ];
  }

  protected setCursor(cursor: CollabSessionPushCursor): void {
    this.getStore()?.set(org2CloudPushCursorsAtom, (current) => ({
      ...current,
      [`${cursor.orgId}:${cursor.sessionId}`]: cursor,
    }));
  }

  protected async computeFrozenChainHash(
    perEventHashes: string[],
    frozenEventCount: number
  ): Promise<string> {
    return sha256Hex(perEventHashes.slice(0, frozenEventCount).join("\n"));
  }

  /** Force the next metadata plane to upsert even if its bytes are unchanged. */
  invalidatePushedMetadataHash(orgId: string, sessionId: string): void {
    this.lastPushedMetadataHashes.delete(`${orgId}:${sessionId}`);
  }

  /**
   * Session ids whose durable markers say THIS device pushed them to the
   * org — the vanished-session GC's candidate set. Only the persisted atoms
   * count: the in-memory hash cache dies with the app and would make the
   * sweep miss rows pushed in earlier runs.
   */
  markedSessionIds(orgId: string): Set<string> {
    const ids = new Set<string>();
    const store = this.getStore();
    if (!store) return ids;
    // Composite keys are `${orgId}:${sessionId}`; cloud org ids are uuids
    // (no colon), so the prefix cut is exact even if a session id has one.
    const prefix = `${orgId}:`;
    for (const key of Object.keys(store.get(org2CloudPushedMetadataAtom))) {
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
    for (const key of Object.keys(store.get(org2CloudPushCursorsAtom))) {
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
    return ids;
  }

  /** Whether local durable state proves this session was previously pushed. */
  wasCloudPushed(orgId: string, sessionId: string): boolean {
    const key = `${orgId}:${sessionId}`;
    return (
      this.lastPushedMetadataHashes.has(key) ||
      this.getPushedMetadataMarker(orgId, sessionId) ||
      this.getCursor(orgId, sessionId) !== undefined
    );
  }

  private getPushedMetadataMarker(orgId: string, sessionId: string): boolean {
    return (
      this.getStore()?.get(org2CloudPushedMetadataAtom)[
        `${orgId}:${sessionId}`
      ] === true
    );
  }

  protected setPushedMetadataMarker(orgId: string, sessionId: string): void {
    const key = `${orgId}:${sessionId}`;
    this.getStore()?.set(org2CloudPushedMetadataAtom, (current) =>
      current[key] ? current : { ...current, [key]: true }
    );
  }

  protected clearPushedMetadataMarker(orgId: string, sessionId: string): void {
    const key = `${orgId}:${sessionId}`;
    this.getStore()?.set(org2CloudPushedMetadataAtom, (current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  protected clearCursor(orgId: string, sessionId: string): void {
    const key = `${orgId}:${sessionId}`;
    this.getStore()?.set(org2CloudPushCursorsAtom, (current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
}
