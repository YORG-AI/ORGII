/**
 * Org-level offline sync (0013).
 *
 * When an org admin enables `offlineSyncEnabled`, member clients bulk-import
 * every replayable teammate session of the ACTIVE org in the background —
 * sequentially, through the exact importer/busy/progress plumbing a manual
 * click uses, so sidebar rows show the same spinner/percent and the local
 * copies are indistinguishable from click-imports (they remain TEAM
 * sessions; imported cache rows never surface under My Sessions).
 *
 * Demand-driven, not a poller (client discipline §2): the scheduler is a
 * store-subscribing singleton (memberRuntimePushScheduler's lifecycle —
 * started/stopped on the auth identity boundary by useOrg2CloudSyncEngine)
 * that reacts to roster / active-scope / remote-listing writes. The listing
 * itself is already signal-driven and 60s-throttled; each remote row is
 * attempted at most once per REMOTE STATE (epoch/seq/count/tailHash
 * fingerprint), so a refresh only re-imports rows the owner actually
 * changed, and rows whose local cursor already matches are skipped without
 * any IPC.
 */
import { createStore } from "jotai";

import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  deriveImportedSessionId,
  findImportedSession,
  importRemoteSession,
} from "../TeamCollaboration/engine/collabSyncEngineHelpers";
import { recordCloudDownloadSample } from "./cloudDownloadEstimator";
import { hiddenRemoteRowIdsForOrg } from "./cloudHiddenRemoteSessions";
import {
  beginCloudSessionBusyAtom,
  cloudSessionBusyRowsAtom,
  endCloudSessionBusyAtom,
  updateCloudSessionBusyAtom,
} from "./cloudSessionBusyAtom";
import {
  registerCloudDownloadAbort,
  unregisterCloudDownloadAbort,
} from "./cloudSessionDownloadAbortRegistry";
import {
  type CloudPausedDownloadCursor,
  cloudSessionPausedDownloadsAtom,
  setCloudPausedDownloadAtom,
} from "./cloudSessionDownloadControlAtoms";
import {
  clearCloudSessionDownloadProgressAtom,
  cloudSessionDownloadProgressAtom,
  completeCloudDownloadProgressWithLinger,
  createThrottledProgressReporter,
  upsertCloudSessionDownloadProgressAtom,
} from "./cloudSessionDownloadProgressAtom";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { buildCloudSessionFetchClient } from "./org2CloudBackendAdapter";
import { getCloudCapabilities } from "./org2CloudCapabilities";
import { ensureFreshSession } from "./org2CloudClient";
import { isFetchTransportError } from "./org2CloudFetchRetry";
import { endpointForOrg } from "./org2CloudOrgEndpointRouter";
import {
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "./org2CloudOrgsAtom";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "./org2CloudRemoteSessionsAtom";

const log = createLogger("Org2CloudOfflineSync");

/** Coalesce bursts of store writes into one sweep decision. */
const SWEEP_DEBOUNCE_MS = 3_000;
/** Breather between sequential background imports (UI/IO fairness). */
const INTER_IMPORT_DELAY_MS = 500;

type JotaiStore = ReturnType<typeof createStore>;

/** Remote-state identity for the attempted-once-per-state memo. */
export function offlineSyncRowFingerprint(
  row: RemoteTeammateSessionMetadata
): string {
  return [
    row.eventsEpoch ?? "",
    row.eventsFrozenSeq ?? "",
    row.eventsCount ?? "",
    row.eventsTailHash ?? "",
  ].join(":");
}

/** Local imported cursor already covers this remote state — nothing to do. */
function localCursorMatches(
  sessions: readonly Session[],
  orgId: string,
  row: RemoteTeammateSessionMetadata,
  sourceEndpointUrl: string
): boolean {
  const existing = findImportedSession(
    sessions as Session[],
    orgId,
    row.sourceSessionId,
    sourceEndpointUrl
  );
  const cursor = existing?.importedFrom;
  if (!cursor) return false;
  return (
    cursor.epoch === row.eventsEpoch &&
    cursor.seq === (row.eventsFrozenSeq ?? 0) &&
    cursor.count === row.eventsCount &&
    (cursor.tailHash ?? null) === (row.eventsTailHash ?? null)
  );
}

export interface PickOfflineSyncCandidatesParams {
  rows: readonly RemoteTeammateSessionMetadata[];
  sessions: readonly Session[];
  orgId: string;
  sourceEndpointUrl: string;
  /**
   * Viewer's own rows are never background-imported: replaying one's own
   * session mints a read-only copy of a possibly-live original (same hazard
   * the auto-replay reveal guards against).
   */
  selfUserId: string | null;
  busyRowIds: ReadonlySet<string>;
  /** User-paused downloads: the sweep must never restart one on its own. */
  pausedRowIds: ReadonlySet<string>;
  /**
   * Rows the user removed ("unsubscribed") from the sidebar. Remove deletes
   * the local copy; re-importing it behind the user's back would make the
   * action meaningless. A manual replay resubscribes.
   */
  unsubscribedRowIds: ReadonlySet<string>;
  /** rowId → fingerprint already attempted (success or failure). */
  attempted: ReadonlyMap<string, string>;
}

/** Pure candidate picker (unit-tested): newest activity first. */
export function pickOfflineSyncCandidates(
  params: PickOfflineSyncCandidatesParams
): RemoteTeammateSessionMetadata[] {
  return params.rows
    .filter((row) => {
      if (row.eventsEpoch === undefined) return false;
      if (row.deletedAt) return false;
      if (params.selfUserId && row.ownerUserId === params.selfUserId) {
        return false;
      }
      if (params.busyRowIds.has(row.id)) return false;
      if (params.pausedRowIds.has(row.id)) return false;
      if (params.unsubscribedRowIds.has(row.id)) return false;
      if (params.attempted.get(row.id) === offlineSyncRowFingerprint(row)) {
        return false;
      }
      return !localCursorMatches(
        params.sessions,
        params.orgId,
        row,
        params.sourceEndpointUrl
      );
    })
    .sort((left, right) =>
      (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "")
    );
}

class Org2CloudOfflineSyncScheduler {
  private store: JotaiStore | null = null;
  private unsubscribers: Array<() => void> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: Promise<void> | null = null;
  /** `${orgId}:${rowId}` → last attempted remote-state fingerprint. */
  private readonly attemptedFingerprints = new Map<string, string>();
  /** In-flight background import, so stop() can cut it, not just the loop. */
  private activeImportAbort: AbortController | null = null;
  private generation = 0;

  start(store: JotaiStore): void {
    this.stop();
    this.store = store;
    const schedule = (): void => this.schedule();
    this.unsubscribers = [
      store.sub(org2CloudOrgsAtom, schedule),
      store.sub(org2CloudRemoteSessionsAtom, schedule),
      store.sub(sidebarActiveCloudOrgIdAtom, schedule),
    ];
    this.schedule();
  }

  stop(): void {
    this.generation += 1;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    // An auth-identity switch must not leave a transfer writing local rows
    // under the previous identity's token; the generation bump makes the
    // abort read as a stop, not a user pause.
    this.activeImportAbort?.abort();
    this.activeImportAbort = null;
    this.store = null;
    this.attemptedFingerprints.clear();
  }

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const generation = this.generation;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (generation !== this.generation) return;
      this.activeRun = (this.activeRun ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => this.runSweep(generation));
    }, SWEEP_DEBOUNCE_MS);
  }

  private async runSweep(generation: number): Promise<void> {
    const store = this.store;
    if (!store || generation !== this.generation) return;
    const auth = store.get(org2CloudAuthAtom);
    if (!auth) return;
    const orgId = store.get(sidebarActiveCloudOrgIdAtom);
    if (!orgId) return;
    const org = store
      .get(org2CloudOrgsAtom)
      .find((candidate) => candidate.orgId === orgId);
    if (!org?.offlineSyncEnabled) return;
    const entry = store.get(org2CloudRemoteSessionsAtom)[orgId];
    const rows =
      remoteSessionsEntryForIdentity(entry, org2CloudAuthIdentityKey(auth))
        ?.rows ?? [];
    if (rows.length === 0) return;
    if (
      !(await getCloudCapabilities(auth.accessToken, endpointForOrg(orgId)))
        .offlineSync
    ) {
      return;
    }
    if (generation !== this.generation) return;

    const candidates = pickOfflineSyncCandidates({
      rows,
      sessions: store.get(sessionsAtom) as Session[],
      orgId,
      sourceEndpointUrl: auth.supabaseUrl,
      selfUserId: auth.userId ?? null,
      busyRowIds: new Set(store.get(cloudSessionBusyRowsAtom).keys()),
      pausedRowIds: new Set(store.get(cloudSessionPausedDownloadsAtom).keys()),
      unsubscribedRowIds: hiddenRemoteRowIdsForOrg(orgId),
      attempted: this.attemptedScopedTo(orgId),
    });
    if (candidates.length === 0) return;
    log.info(
      `offline sync: importing ${candidates.length} session(s) for org ${orgId}`
    );
    for (const row of candidates) {
      if (generation !== this.generation) return;
      // Mid-sweep policy/scope changes end the sweep: an admin turning the
      // flag off (or the user switching workspaces) must not have to wait
      // out a long candidate queue.
      if (store.get(sidebarActiveCloudOrgIdAtom) !== orgId) return;
      const liveOrg = store
        .get(org2CloudOrgsAtom)
        .find((candidate) => candidate.orgId === orgId);
      if (!liveOrg?.offlineSyncEnabled) return;
      const outcome = await this.importOne(store, orgId, row, generation);
      // Attempted-once-per-remote-state, success or failure: a permanent
      // failure (e.g. retention) must not retry on every listing refresh.
      // Recorded only AFTER a genuine attempt — a transient outcome (no
      // usable token, transport failure before the server answered) leaves
      // the slot open so connectivity recovery retries on the next signal.
      if (outcome === "attempted") {
        this.attemptedFingerprints.set(
          `${orgId}:${row.id}`,
          offlineSyncRowFingerprint(row)
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, INTER_IMPORT_DELAY_MS)
      );
    }
  }

  private attemptedScopedTo(orgId: string): Map<string, string> {
    const scoped = new Map<string, string>();
    const prefix = `${orgId}:`;
    for (const [key, value] of this.attemptedFingerprints) {
      if (key.startsWith(prefix)) scoped.set(key.slice(prefix.length), value);
    }
    return scoped;
  }

  /**
   * "attempted" ⇒ the remote state was genuinely tried (success, failure,
   * or user pause) and must not auto-retry until it changes. "transient" ⇒
   * no usable token or the transport died before the server answered — the
   * attempt slot stays open so connectivity recovery retries.
   */
  private async importOne(
    store: JotaiStore,
    orgId: string,
    row: RemoteTeammateSessionMetadata,
    generation: number
  ): Promise<"attempted" | "transient"> {
    const current = store.get(org2CloudAuthAtom);
    if (!current) {
      log.rateLimited(
        `offline-sync-auth-${orgId}`,
        60_000,
        "offline sync import skipped: no auth in store"
      );
      return "transient";
    }
    const fresh = await ensureFreshSession(current);
    if (!fresh) {
      log.rateLimited(
        `offline-sync-auth-${orgId}`,
        60_000,
        "offline sync import skipped: token refresh unavailable"
      );
      return "transient";
    }
    commitRefreshedAuth(
      (update) => store.set(org2CloudAuthAtom, update),
      current,
      fresh
    );
    const sourceEndpointUrl = fresh.supabaseUrl;
    if (store.get(cloudSessionBusyRowsAtom).has(row.id)) return "attempted";
    store.set(beginCloudSessionBusyAtom, {
      rowId: row.id,
      entry: { kind: "replay", orgId },
    });
    // Same pause affordance as a manual download: the progress card's
    // Pause button aborts a background import too.
    const abortController = new AbortController();
    this.activeImportAbort = abortController;
    registerCloudDownloadAbort(row.id, () => abortController.abort());
    let localSessionId: string | null = null;
    let pausedCaptured: CloudPausedDownloadCursor | null = null;
    let pausedCommitted = false;
    let completedOk = false;
    let outcome: "attempted" | "transient" = "attempted";
    let progressReporter: ReturnType<
      typeof createThrottledProgressReporter
    > | null = null;
    try {
      const sessions = store.get(sessionsAtom) as Session[];
      localSessionId =
        findImportedSession(
          sessions,
          orgId,
          row.sourceSessionId,
          sourceEndpointUrl
        )?.session_id ??
        (await deriveImportedSessionId(
          orgId,
          row.sourceSessionId,
          sourceEndpointUrl
        ));
      const importSessionId = localSessionId;
      store.set(updateCloudSessionBusyAtom, {
        rowId: row.id,
        patch: { localSessionId: importSessionId },
      });
      // Covered base for progress/rate: the sample must only describe what
      // THIS transfer moved, or one incremental delta inflates the device
      // rate by orders of magnitude.
      const existingCursor = findImportedSession(
        store.get(sessionsAtom) as Session[],
        orgId,
        row.sourceSessionId,
        sourceEndpointUrl
      )?.importedFrom;
      const baseEvents =
        existingCursor && existingCursor.epoch === row.eventsEpoch
          ? existingCursor.count
          : 0;
      const progressStartedAt = Date.now();
      let maxLoadedEvents = 0;
      const reporter = createThrottledProgressReporter((payload) =>
        store.set(upsertCloudSessionDownloadProgressAtom, payload)
      );
      progressReporter = reporter;
      const reportProgress = (
        loadedEvents: number,
        totalEvents: number | null,
        phase: "downloading" | "finalizing" = "downloading"
      ): void => {
        maxLoadedEvents = Math.max(maxLoadedEvents, loadedEvents);
        reporter.report({
          localSessionId: importSessionId,
          progress: {
            rowId: row.id,
            orgId,
            loadedEvents: maxLoadedEvents,
            totalEvents,
            baseEvents,
            startedAtMs: progressStartedAt,
            updatedAtMs: Date.now(),
            phase,
          },
        });
      };
      // Candidates are cursor-stale by selection, so a transfer is coming:
      // show the row spinner/percent immediately, not at the first tick.
      reportProgress(baseEvents, row.eventsCount ?? null);
      const result = await importRemoteSession({
        client: buildCloudSessionFetchClient(fresh.accessToken, undefined, {
          onTransferProgress: (progress) =>
            reportProgress(
              baseEvents + progress.decodedEvents,
              progress.totalEvents
            ),
        }),
        orgId,
        remoteSession: row,
        sourceEndpointUrl,
        signal: abortController.signal,
        onProgress: (progress) =>
          reportProgress(
            progress.loadedEvents,
            progress.totalEvents,
            progress.phase ?? "downloading"
          ),
        onPauseState: (state) => {
          pausedCaptured = state;
        },
      });
      if (result?.updated && maxLoadedEvents > baseEvents) {
        recordCloudDownloadSample(
          maxLoadedEvents - baseEvents,
          Date.now() - progressStartedAt
        );
      }
      completedOk = true;
    } catch (error) {
      if (abortController.signal.aborted) {
        // The progress card's Pause button reaches background imports too:
        // hold the position for a user-driven resume instead of vanishing.
        // A stop()-driven abort (auth switch) is NOT a pause: write nothing.
        progressReporter?.cancel();
        if (localSessionId && generation === this.generation) {
          const lastProgress = store
            .get(cloudSessionDownloadProgressAtom)
            .get(localSessionId);
          // Widened read: TS control-flow ignores the closure assignment.
          const captured = pausedCaptured as CloudPausedDownloadCursor | null;
          store.set(setCloudPausedDownloadAtom, {
            rowId: row.id,
            entry: {
              localSessionId,
              orgId,
              totalEvents: lastProgress?.totalEvents ?? row.eventsCount ?? null,
              loadedEvents: lastProgress?.loadedEvents ?? captured?.count ?? 0,
              cursor: captured,
            },
          });
          store.set(upsertCloudSessionDownloadProgressAtom, {
            localSessionId,
            progress: {
              rowId: row.id,
              orgId,
              loadedEvents: lastProgress?.loadedEvents ?? captured?.count ?? 0,
              totalEvents: lastProgress?.totalEvents ?? row.eventsCount ?? null,
              startedAtMs: lastProgress?.startedAtMs ?? Date.now(),
              updatedAtMs: Date.now(),
              phase: "paused",
            },
          });
          pausedCommitted = true;
        }
      } else if (isFetchTransportError(error)) {
        // The server never answered — connectivity blip, not a verdict on
        // this remote state. Leave the attempt slot open.
        outcome = "transient";
        log.rateLimited(
          `offline-sync-import-${orgId}`,
          60_000,
          `offline sync import hit a transport failure for ${row.sourceSessionId}`,
          error
        );
      } else {
        log.rateLimited(
          `offline-sync-import-${orgId}`,
          60_000,
          `offline sync import failed for ${row.sourceSessionId}`,
          error
        );
      }
    } finally {
      if (this.activeImportAbort === abortController) {
        this.activeImportAbort = null;
      }
      unregisterCloudDownloadAbort(row.id);
      store.set(endCloudSessionBusyAtom, row.id);
      // A parked trailing tick must never resurrect the entry this
      // teardown clears (or overwrite the paused state it just wrote).
      progressReporter?.cancel();
      if (localSessionId && !pausedCommitted) {
        if (completedOk) {
          completeCloudDownloadProgressWithLinger(store, localSessionId);
        } else {
          store.set(clearCloudSessionDownloadProgressAtom, localSessionId);
        }
      }
    }
    return outcome;
  }
}

export const org2CloudOfflineSyncScheduler =
  new Org2CloudOfflineSyncScheduler();
