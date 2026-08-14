/**
 * Replay / fork actions for one cloud org's remote sessions.
 *
 * Extracted from CloudOrgPanelView's handleReplaySession / handleForkSession
 * so the sidebar's threaded cloud-session rows can reuse the exact same
 * import/fork/openSession/toast/retention semantics. Replay/fork ride the
 * SAME backend-agnostic machinery as the self-hosted panel
 * (`importRemoteSession` / `forkTeammateSession`); only the segments fetch
 * differs (`buildCloudSessionFetchClient`, JWT-backed).
 */
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import {
  beginSessionHydrationAtom,
  endSessionHydrationAtom,
  triggerSessionReloadAtom,
} from "@src/engines/SessionCore";
import {
  deriveImportedSessionId,
  findImportedSession,
  importRemoteSession,
} from "@src/features/TeamCollaboration/engine/collabSyncEngineHelpers";
import {
  ForkCancelledError,
  forkTeammateSession,
  resolveForkWorkspacePath,
} from "@src/features/TeamCollaboration/forkSession";
import { classifyForkOperationError } from "@src/features/TeamCollaboration/forkSnapshotIntegrity";
import { createLogger } from "@src/hooks/logger";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { openOrReplaceSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { activeSessionIdAtom, sessionsAtom } from "@src/store/session";

import {
  decideCloudDownloadGate,
  recordCloudDownloadSample,
} from "./cloudDownloadEstimator";
import { dismissCloudReferenceOpeningToast } from "./cloudReferenceOpeningToast";
import {
  type CloudSessionBusyEntry,
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
  clearCloudDownloadPendingPlayAtom,
  clearCloudPausedDownloadAtom,
  cloudSessionPausedDownloadsAtom,
  setCloudDownloadPendingPlayAtom,
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
  buildCloudPendingPlayEntry,
  resolveCloudSessionEnvironmentIdentity,
  resolveCloudSessionReplayIconId,
  runImmediateCloudSessionReplay,
} from "./cloudSessionReplayLifecycle";
import { applyCloudTurnSkeleton } from "./cloudSessionTurnSkeleton";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { buildCloudSessionFetchClient } from "./org2CloudBackendAdapter";
import { ensureFreshSession } from "./org2CloudClient";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";
import { useOpenCloudBilling } from "./useOpenCloudBilling";

const log = createLogger("useCloudSessionActions");

export interface CloudSessionReplayOptions {
  /**
   * Surface that should show the replay, called synchronously with the local
   * session id the import will write into — before the remote transcript is
   * fetched. Defaults to opening/replacing a Chat Pane session tab.
   *
   * Boards that are themselves unmounted by a tab switch (Work Management
   * only mounts while its tab is active) MUST pass their own in-place
   * surface: opening a tab would tear down the caller and abort the import
   * it just started, leaving the new tab permanently empty.
   */
  openSurface?: (params: {
    localSessionId: string;
    remoteSession: RemoteTeammateSessionMetadata;
  }) => void;
  /**
   * True for starts the user already confirmed (the play card's Start
   * button): the big-session play gate is skipped and the transfer begins
   * immediately. Resumes of paused downloads skip the gate on their own.
   */
  skipDownloadGate?: boolean;
}

export interface CloudSessionForkOptions {
  /** True for starts the play card's Start button already confirmed. */
  skipDownloadGate?: boolean;
}

export type CloudSessionActionOutcome =
  | "opened"
  /** The click raced past the server-side retention filter — show upgrade. */
  | "retention-expired"
  | "failed"
  /** Row not actionable (nothing published / another action in flight). */
  | "noop";

export interface UseCloudSessionActionsResult {
  replaySession: (
    remoteSession: RemoteTeammateSessionMetadata,
    options?: CloudSessionReplayOptions
  ) => Promise<CloudSessionActionOutcome>;
  forkSession: (
    remoteSession: RemoteTeammateSessionMetadata,
    options?: CloudSessionForkOptions
  ) => Promise<CloudSessionActionOutcome>;
  /**
   * Row ids (`remoteSession.id`) with a replay/fork in flight. Per-row and
   * store-backed: a busy row only ever blocks itself, and every mounted
   * consumer (both sidebar connectors, Kanban) sees the same registry.
   */
  busySessionRows: ReadonlyMap<string, CloudSessionBusyEntry>;
}

/** Per-org replay/fork actions for cloud remote-session rows. */
export function useCloudSessionActions(
  orgId: string | null
): UseCloudSessionActionsResult {
  const { t } = useTranslation("navigation");
  const store = useStore();
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const { openSession, updateMetadata } = useSessionView();
  const openOrReplaceSessionTab = useSetAtom(
    openOrReplaceSessionInChatPanelTabAtom
  );
  const beginSessionHydration = useSetAtom(beginSessionHydrationAtom);
  const endSessionHydration = useSetAtom(endSessionHydrationAtom);
  const triggerSessionReload = useSetAtom(triggerSessionReloadAtom);
  const openCloudBillingPage = useOpenCloudBilling();
  const busySessionRows = useAtomValue(cloudSessionBusyRowsAtom);
  const beginSessionBusy = useSetAtom(beginCloudSessionBusyAtom);
  const updateSessionBusy = useSetAtom(updateCloudSessionBusyAtom);
  const endSessionBusy = useSetAtom(endCloudSessionBusyAtom);
  const upsertDownloadProgress = useSetAtom(
    upsertCloudSessionDownloadProgressAtom
  );
  const clearDownloadProgress = useSetAtom(
    clearCloudSessionDownloadProgressAtom
  );
  // Latest auth via ref so token-refresh writes don't recreate callbacks
  // (same idiom as the panel fetch effects).
  const authRef = useRef(auth);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  // One controller per in-flight replay row; unmount aborts the
  // fetch/decode/apply instead of merely ignoring the result. A map, not a
  // single slot: rows download concurrently now.
  const replayAbortsRef = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const aborts = replayAbortsRef.current;
    return () => {
      for (const controller of aborts.values()) controller.abort();
      aborts.clear();
    };
  }, [authIdentityKey, orgId]);

  /** Fresh JWT for a user action (same refresh idiom as the panel). */
  const freshAccessToken = useCallback(async (): Promise<string | null> => {
    const current = authRef.current;
    if (!current) return null;
    const fresh = await ensureFreshSession(current);
    if (!fresh) return null;
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth]);

  const notifyRetentionExpired = useCallback(() => {
    Message.error(t("cloud.orgPanel.retentionUpgrade"), {
      cancel: {
        label: t("cloud.orgPanel.upgrade"),
        onClick: openCloudBillingPage,
      },
    });
  }, [openCloudBillingPage, t]);

  // Read-only replay: same shared importer the self-hosted panel row uses,
  // only the segments-fetch client differs. Rows are server-filtered to the
  // retention window, but a click can race past it — ORG2_RETENTION_EXPIRED
  // then surfaces as an upgrade prompt, not a generic failure.
  const replaySession = useCallback(
    async (
      remoteSession: RemoteTeammateSessionMetadata,
      options?: CloudSessionReplayOptions
    ): Promise<CloudSessionActionOutcome> => {
      if (!orgId || remoteSession.eventsEpoch === undefined) return "noop";
      // Store read at call time: the render-captured map can be stale, and
      // both sidebar connectors plus Kanban share this registry. Only the
      // clicked row's own in-flight action blocks it.
      if (store.get(cloudSessionBusyRowsAtom).has(remoteSession.id)) {
        return "noop";
      }
      // A paused download resumes on the next start; it is never re-gated.
      const pausedEntry =
        store.get(cloudSessionPausedDownloadsAtom).get(remoteSession.id) ??
        null;
      // Big-session play gate: the listing already knows the event count and
      // the device knows its observed download rate. Instead of a blocking
      // modal, the Chat Pane tab opens immediately with a play card (count +
      // ETA) and nothing transfers until the user hits Start. Only the
      // not-yet-covered remainder counts (a cached copy that just needs a
      // delta stays gate-free). Every replay import is interactive; the org's
      // background-upload policy affects owner pushes, not downloads.
      if (!pausedEntry && !options?.skipDownloadGate) {
        const gateEndpointUrl = authRef.current?.supabaseUrl;
        const gateSession = gateEndpointUrl
          ? findImportedSession(
              store.get(sessionsAtom),
              orgId,
              remoteSession.sourceSessionId,
              gateEndpointUrl
            )
          : undefined;
        const gateCursor = gateSession?.importedFrom;
        const coveredCount =
          gateCursor && gateCursor.epoch === remoteSession.eventsEpoch
            ? gateCursor.count
            : 0;
        const pendingEvents = Math.max(
          0,
          (remoteSession.eventsCount ?? 0) - coveredCount
        );
        const decision = decideCloudDownloadGate(pendingEvents);
        if (decision.gate && gateEndpointUrl) {
          const pendingLocalId =
            gateSession?.session_id ??
            (await deriveImportedSessionId(
              orgId,
              remoteSession.sourceSessionId,
              gateEndpointUrl
            ));
          store.set(setCloudDownloadPendingPlayAtom, {
            localSessionId: pendingLocalId,
            entry: buildCloudPendingPlayEntry({
              remoteSession,
              orgId,
              pendingEvents,
              etaMs: decision.etaMs,
              kind: "replay",
            }),
          });
          dismissCloudReferenceOpeningToast();
          if (options?.openSurface) {
            options.openSurface({
              localSessionId: pendingLocalId,
              remoteSession,
            });
          } else {
            openOrReplaceSessionTab({
              sessionId: pendingLocalId,
              sessionName: remoteSession.title,
            });
          }
          return "noop";
        }
      }
      if (store.get(cloudSessionBusyRowsAtom).has(remoteSession.id)) {
        return "noop";
      }
      beginSessionBusy({
        rowId: remoteSession.id,
        entry: { kind: "replay", orgId },
      });
      store.set(clearCloudPausedDownloadAtom, remoteSession.id);
      const abortController = new AbortController();
      replayAbortsRef.current.get(remoteSession.id)?.abort();
      replayAbortsRef.current.set(remoteSession.id, abortController);
      registerCloudDownloadAbort(remoteSession.id, () =>
        abortController.abort()
      );
      let localSessionId: string | null = null;
      let pausedCaptured: CloudPausedDownloadCursor | null = null;
      let pausedCommitted = false;
      let completedOk = false;
      let progressReporter: ReturnType<
        typeof createThrottledProgressReporter
      > | null = null;
      try {
        const sourceEndpointUrl = authRef.current?.supabaseUrl;
        if (!sourceEndpointUrl) {
          Message.error(t("cloud.orgPanel.importError"));
          return "failed";
        }
        const existing = findImportedSession(
          store.get(sessionsAtom),
          orgId,
          remoteSession.sourceSessionId,
          sourceEndpointUrl
        );
        localSessionId =
          existing?.session_id ??
          (await deriveImportedSessionId(
            orgId,
            remoteSession.sourceSessionId,
            sourceEndpointUrl
          ));
        // Immutable copy for the closures below (TS cannot narrow the
        // mutable `let` the finally block needs).
        const importSessionId = localSessionId;
        store.set(clearCloudDownloadPendingPlayAtom, importSessionId);
        // A click on this row while the download runs refocuses this tab.
        updateSessionBusy({
          rowId: remoteSession.id,
          patch: { localSessionId: importSessionId },
        });
        // Events already durable before this start: a paused download's
        // persisted pages, or the covered base of an incremental refresh.
        // Progress starts from it and the rate sample must exclude it.
        const baseEvents =
          pausedEntry?.cursor?.count ??
          (existing?.importedFrom &&
          existing.importedFrom.epoch === remoteSession.eventsEpoch
            ? existing.importedFrom.count
            : 0);

        const progressStartedAt = Date.now();
        // Two sources feed one bar: segment-granular decode ticks (fine,
        // during the long storage-object transfer of a 64-segment page)
        // and the importer's post-persist page reports (absolute,
        // including any incremental base). They interleave — keep the
        // bar monotonic with a max-merge. A resumed download starts the
        // bar from the paused position instead of zero.
        let maxLoadedEvents = pausedEntry ? baseEvents : 0;
        const reporter = createThrottledProgressReporter((payload) =>
          upsertDownloadProgress(payload)
        );
        progressReporter = reporter;
        const reportDownloadProgress = (
          loadedEvents: number,
          totalEvents: number | null,
          phase: "downloading" | "finalizing" = "downloading"
        ) => {
          maxLoadedEvents = Math.max(maxLoadedEvents, loadedEvents);
          reporter.report({
            localSessionId: importSessionId,
            progress: {
              rowId: remoteSession.id,
              orgId,
              sessionEnvironment:
                resolveCloudSessionEnvironmentIdentity(remoteSession),
              loadedEvents: maxLoadedEvents,
              totalEvents,
              baseEvents,
              startedAtMs: progressStartedAt,
              updatedAtMs: Date.now(),
              phase,
            },
          });
        };
        // When a transfer is genuinely coming (fresh import, stale cursor,
        // resume), surface the bar in the SAME frame as the click — the
        // token refresh and workspace resolution ahead of the first network
        // tick used to leave a second of dead air. A cursor-current reopen
        // stays silent: seeding it would flash a bar over an instant open.
        const seedCursor = existing?.importedFrom;
        const cursorCurrent =
          !!seedCursor &&
          seedCursor.epoch === remoteSession.eventsEpoch &&
          seedCursor.seq === (remoteSession.eventsFrozenSeq ?? 0) &&
          seedCursor.count === remoteSession.eventsCount &&
          (seedCursor.tailHash ?? null) ===
            (remoteSession.eventsTailHash ?? null);
        if (!cursorCurrent) {
          reportDownloadProgress(
            baseEvents,
            remoteSession.eventsCount ?? pausedEntry?.totalEvents ?? null
          );
        }

        let localRepoPath: string | undefined;
        const result = await runImmediateCloudSessionReplay({
          sessionId: importSessionId,
          beginHydration: (sessionId) =>
            beginSessionHydration({
              sessionId,
              iconId: resolveCloudSessionReplayIconId(remoteSession),
            }),
          openTab: (sessionId) => {
            if (options?.openSurface) {
              options.openSurface({
                localSessionId: sessionId,
                remoteSession,
              });
              return;
            }
            openOrReplaceSessionTab({
              sessionId,
              sessionName: remoteSession.title,
            });
          },
          load: async () => {
            const accessToken = await freshAccessToken();
            abortController.signal.throwIfAborted();
            if (!accessToken) return null;
            // Round-first skeleton (0012): for a fresh import, fetch the
            // owner-published turn index IN PARALLEL with the download and
            // render every round (prompt + placeholder) immediately. Guarded
            // so a fast import that already hydrated the real initial window
            // is never shadowed by a late skeleton write.
            let importSettled = false;
            if (!existing) {
              void applyCloudTurnSkeleton({
                accessToken,
                orgId,
                remoteSession,
                localSessionId: importSessionId,
                signal: abortController.signal,
                shouldApply: () => !importSettled,
              });
            }
            // Resolve after opening so checkout discovery cannot delay the
            // Chat Pane tab. The path later restores local tab metadata and
            // feeds the derived blame index.
            localRepoPath =
              (await resolveForkWorkspacePath(remoteSession)) ?? undefined;
            abortController.signal.throwIfAborted();
            const importPromise = importRemoteSession({
              client: buildCloudSessionFetchClient(accessToken, undefined, {
                onTransferProgress: (progress) =>
                  reportDownloadProgress(
                    // Decode ticks count THIS transfer only; rebase them so
                    // a resumed bar keeps describing the whole session.
                    baseEvents + progress.decodedEvents,
                    progress.totalEvents
                  ),
              }),
              orgId,
              remoteSession,
              sourceEndpointUrl,
              workspaceRepoPath: localRepoPath,
              signal: abortController.signal,
              onProgress: (progress) =>
                reportDownloadProgress(
                  progress.loadedEvents,
                  progress.totalEvents,
                  progress.phase ?? "downloading"
                ),
              onPauseState: (state) => {
                pausedCaptured = state;
              },
              ...(pausedEntry?.cursor
                ? { resumeCursor: pausedEntry.cursor }
                : {}),
            });
            try {
              const result = await importPromise;
              // Feed the device's rate estimator so the next play card
              // quotes a realistic ETA. Only the events THIS transfer moved
              // count — sampling the absolute total against a delta's
              // elapsed time would inflate the rate device-wide.
              if (result?.updated && maxLoadedEvents > baseEvents) {
                recordCloudDownloadSample(
                  maxLoadedEvents - baseEvents,
                  Date.now() - progressStartedAt
                );
              }
              return result;
            } finally {
              importSettled = true;
            }
          },
          endHydration: endSessionHydration,
        });
        if (result) {
          if (result.localSessionId !== importSessionId) {
            log.warn("cloud replay resolved a different local session id", {
              expected: importSessionId,
              actual: result.localSessionId,
              sourceSessionId: remoteSession.sourceSessionId,
            });
          }
          // Do not navigate here: the user may have left or closed the tab
          // while the network request was running. Reload only the still-live
          // surface; inactive sessions read the persisted cache when reopened.
          if (store.get(activeSessionIdAtom) === result.localSessionId) {
            updateMetadata({ repoPath: localRepoPath });
            triggerSessionReload(result.localSessionId);
          }
          completedOk = true;
          return "opened";
        }
        // null ⇒ owner has published no segments (metadata-only card).
        Message.error(t("cloud.orgPanel.importError"));
        return "failed";
      } catch (error) {
        if (abortController.signal.aborted) {
          // Pause, not cancel: keep the progress entry (flipped to paused)
          // so the card shows the held position with a Resume affordance.
          // The captured cursor lets the next start continue the transfer;
          // without one it simply restreams. (Widened reads below: TS
          // control-flow ignores the closure assignments.)
          (
            progressReporter as ReturnType<
              typeof createThrottledProgressReporter
            > | null
          )?.cancel();
          if (localSessionId) {
            const lastProgress = store
              .get(cloudSessionDownloadProgressAtom)
              .get(localSessionId);
            // Widened read: TS control-flow ignores the closure assignment.
            const captured = pausedCaptured as CloudPausedDownloadCursor | null;
            const heldLoaded =
              lastProgress?.loadedEvents ?? captured?.count ?? 0;
            const heldTotal =
              lastProgress?.totalEvents ?? remoteSession.eventsCount ?? null;
            store.set(setCloudPausedDownloadAtom, {
              rowId: remoteSession.id,
              entry: {
                localSessionId,
                orgId,
                totalEvents: heldTotal,
                loadedEvents: heldLoaded,
                cursor: captured,
              },
            });
            upsertDownloadProgress({
              localSessionId,
              progress: {
                rowId: remoteSession.id,
                orgId,
                sessionEnvironment:
                  resolveCloudSessionEnvironmentIdentity(remoteSession),
                loadedEvents: heldLoaded,
                totalEvents: heldTotal,
                startedAtMs: lastProgress?.startedAtMs ?? Date.now(),
                updatedAtMs: Date.now(),
                phase: "paused",
              },
            });
            pausedCommitted = true;
          }
          return "noop";
        }
        if (isOrg2SyncErrorCode(error, "ORG2_RETENTION_EXPIRED")) {
          notifyRetentionExpired();
          return "retention-expired";
        }
        // Listing said replayable but the read raced a sharing-level /
        // floor change — name the reason instead of the generic toast.
        if (isOrg2SyncErrorCode(error, "ORG2_REPLAY_NOT_AVAILABLE")) {
          Message.error(t("cloud.sidebar.metadataOnly"));
          return "failed";
        }
        log.error("cloud session replay failed", error);
        Message.error(t("cloud.orgPanel.importError"));
        return "failed";
      } finally {
        if (replayAbortsRef.current.get(remoteSession.id) === abortController) {
          replayAbortsRef.current.delete(remoteSession.id);
        }
        unregisterCloudDownloadAbort(remoteSession.id);
        endSessionBusy(remoteSession.id);
        // A parked trailing tick must never resurrect the entry this
        // teardown clears (or overwrite the paused state it just wrote).
        (
          progressReporter as ReturnType<
            typeof createThrottledProgressReporter
          > | null
        )?.cancel();
        if (localSessionId && !pausedCommitted) {
          if (completedOk) {
            // Success holds a terminal "completed · 100%" card until the
            // surface has been visible for the minimum window — a sub-second
            // transfer used to flash and vanish like a glitch.
            completeCloudDownloadProgressWithLinger(store, localSessionId);
          } else {
            clearDownloadProgress(localSessionId);
          }
        }
      }
    },
    [
      beginSessionBusy,
      beginSessionHydration,
      clearDownloadProgress,
      endSessionBusy,
      endSessionHydration,
      freshAccessToken,
      openOrReplaceSessionTab,
      notifyRetentionExpired,
      orgId,
      store,
      t,
      triggerSessionReload,
      updateMetadata,
      updateSessionBusy,
      upsertDownloadProgress,
    ]
  );

  // Fork & continue: same full relay as the self-hosted ⑂ row action —
  // engine fork + backend row registration + first-send context handoff.
  const forkSession = useCallback(
    async (
      remoteSession: RemoteTeammateSessionMetadata,
      options?: CloudSessionForkOptions
    ): Promise<CloudSessionActionOutcome> => {
      if (!orgId || remoteSession.eventsEpoch === undefined) return "noop";
      if (store.get(cloudSessionBusyRowsAtom).has(remoteSession.id)) {
        return "noop";
      }
      // Big-session gate, replay parity: a Take Over whose pre-import would
      // stream a large transcript parks the same play card (count + ETA) in
      // the imported copy's pane and transfers nothing until Start. A
      // current local copy, a resumable pause, or a small delta stays
      // gate-free — those never surprise with a long transfer.
      if (!options?.skipDownloadGate) {
        const gateEndpointUrl = authRef.current?.supabaseUrl;
        const pausedGateEntry = store
          .get(cloudSessionPausedDownloadsAtom)
          .get(remoteSession.id);
        if (gateEndpointUrl && !pausedGateEntry) {
          const gateSession = findImportedSession(
            store.get(sessionsAtom),
            orgId,
            remoteSession.sourceSessionId,
            gateEndpointUrl
          );
          const gateCursor = gateSession?.importedFrom;
          const coveredCount =
            gateCursor && gateCursor.epoch === remoteSession.eventsEpoch
              ? gateCursor.count
              : 0;
          const pendingEvents = Math.max(
            0,
            (remoteSession.eventsCount ?? 0) - coveredCount
          );
          const decision = decideCloudDownloadGate(pendingEvents);
          if (decision.gate) {
            const pendingLocalId =
              gateSession?.session_id ??
              (await deriveImportedSessionId(
                orgId,
                remoteSession.sourceSessionId,
                gateEndpointUrl
              ));
            store.set(setCloudDownloadPendingPlayAtom, {
              localSessionId: pendingLocalId,
              entry: buildCloudPendingPlayEntry({
                remoteSession,
                orgId,
                pendingEvents,
                etaMs: decision.etaMs,
                kind: "fork",
              }),
            });
            openOrReplaceSessionTab({
              sessionId: pendingLocalId,
              sessionName: remoteSession.title,
            });
            return "noop";
          }
        }
      }
      beginSessionBusy({
        rowId: remoteSession.id,
        entry: { kind: "fork", orgId },
      });
      let forkPausedCommitted = false;
      try {
        const accessToken = await freshAccessToken();
        if (!accessToken) {
          Message.error(t("collaboration.session.forkFailed"));
          return "failed";
        }
        // Local-copy-first parity: a Take Over of a session without a
        // CURRENT local replay copy first runs the standard streamed import
        // — same sidebar spinner/percent, same pause/resume semantics, and
        // the fork then assembles from the local copy without a second
        // download. An already-imported current copy makes this pre-step a
        // no-op.
        const sourceEndpointUrl = authRef.current?.supabaseUrl;
        if (sourceEndpointUrl) {
          const existing = findImportedSession(
            store.get(sessionsAtom),
            orgId,
            remoteSession.sourceSessionId,
            sourceEndpointUrl
          );
          const cursor = existing?.importedFrom;
          const cursorCurrent =
            !!cursor &&
            cursor.epoch === remoteSession.eventsEpoch &&
            cursor.seq === (remoteSession.eventsFrozenSeq ?? 0) &&
            cursor.count === remoteSession.eventsCount &&
            (cursor.tailHash ?? null) ===
              (remoteSession.eventsTailHash ?? null);
          if (!cursorCurrent) {
            const pausedEntry =
              store
                .get(cloudSessionPausedDownloadsAtom)
                .get(remoteSession.id) ?? null;
            store.set(clearCloudPausedDownloadAtom, remoteSession.id);
            const abortController = new AbortController();
            registerCloudDownloadAbort(remoteSession.id, () =>
              abortController.abort()
            );
            const importSessionId =
              existing?.session_id ??
              (await deriveImportedSessionId(
                orgId,
                remoteSession.sourceSessionId,
                sourceEndpointUrl
              ));
            store.set(clearCloudDownloadPendingPlayAtom, importSessionId);
            updateSessionBusy({
              rowId: remoteSession.id,
              patch: { localSessionId: importSessionId },
            });
            const baseEvents =
              pausedEntry?.cursor?.count ??
              (cursor && cursor.epoch === remoteSession.eventsEpoch
                ? cursor.count
                : 0);
            const progressStartedAt = Date.now();
            let maxLoadedEvents = pausedEntry ? baseEvents : 0;
            const reporter = createThrottledProgressReporter((payload) =>
              upsertDownloadProgress(payload)
            );
            const reportDownloadProgress = (
              loadedEvents: number,
              totalEvents: number | null,
              phase: "downloading" | "finalizing" = "downloading"
            ) => {
              maxLoadedEvents = Math.max(maxLoadedEvents, loadedEvents);
              reporter.report({
                localSessionId: importSessionId,
                progress: {
                  rowId: remoteSession.id,
                  orgId,
                  sessionEnvironment:
                    resolveCloudSessionEnvironmentIdentity(remoteSession),
                  loadedEvents: maxLoadedEvents,
                  totalEvents,
                  baseEvents,
                  startedAtMs: progressStartedAt,
                  updatedAtMs: Date.now(),
                  phase,
                },
              });
            };
            reportDownloadProgress(
              baseEvents,
              remoteSession.eventsCount ?? pausedEntry?.totalEvents ?? null
            );
            let pausedCaptured: CloudPausedDownloadCursor | null = null;
            try {
              const imported = await importRemoteSession({
                client: buildCloudSessionFetchClient(accessToken, undefined, {
                  onTransferProgress: (progress) =>
                    reportDownloadProgress(
                      baseEvents + progress.decodedEvents,
                      progress.totalEvents
                    ),
                }),
                orgId,
                remoteSession,
                sourceEndpointUrl,
                signal: abortController.signal,
                onProgress: (progress) =>
                  reportDownloadProgress(
                    progress.loadedEvents,
                    progress.totalEvents,
                    progress.phase ?? "downloading"
                  ),
                onPauseState: (state) => {
                  pausedCaptured = state;
                },
                ...(pausedEntry?.cursor
                  ? { resumeCursor: pausedEntry.cursor }
                  : {}),
              });
              if (imported?.updated && maxLoadedEvents > baseEvents) {
                recordCloudDownloadSample(
                  maxLoadedEvents - baseEvents,
                  Date.now() - progressStartedAt
                );
              }
            } catch (error) {
              if (abortController.signal.aborted) {
                const lastProgress = store
                  .get(cloudSessionDownloadProgressAtom)
                  .get(importSessionId);
                const captured =
                  pausedCaptured as CloudPausedDownloadCursor | null;
                const heldLoaded =
                  lastProgress?.loadedEvents ?? captured?.count ?? 0;
                const heldTotal =
                  lastProgress?.totalEvents ??
                  remoteSession.eventsCount ??
                  null;
                store.set(setCloudPausedDownloadAtom, {
                  rowId: remoteSession.id,
                  entry: {
                    localSessionId: importSessionId,
                    orgId,
                    totalEvents: heldTotal,
                    loadedEvents: heldLoaded,
                    cursor: captured,
                  },
                });
                upsertDownloadProgress({
                  localSessionId: importSessionId,
                  progress: {
                    rowId: remoteSession.id,
                    orgId,
                    sessionEnvironment:
                      resolveCloudSessionEnvironmentIdentity(remoteSession),
                    loadedEvents: heldLoaded,
                    totalEvents: heldTotal,
                    startedAtMs: lastProgress?.startedAtMs ?? Date.now(),
                    updatedAtMs: Date.now(),
                    phase: "paused",
                  },
                });
                forkPausedCommitted = true;
                return "noop";
              }
              throw error;
            } finally {
              unregisterCloudDownloadAbort(remoteSession.id);
              reporter.cancel();
              if (!forkPausedCommitted) {
                clearDownloadProgress(importSessionId);
              }
            }
          }
        }
        const result = await forkTeammateSession({
          client: buildCloudSessionFetchClient(accessToken),
          orgId,
          remoteSession,
          ...(sourceEndpointUrl ? { sourceEndpointUrl } : {}),
          promptForExecution: true,
        });
        if (!result) {
          Message.error(t("collaboration.session.forkFailed"));
          return "failed";
        }
        Message.success(
          t("collaboration.session.forkedFromLabel", {
            name: remoteSession.ownerDisplayName,
          })
        );
        // result.repoPath is the RESOLVED local checkout (or undefined when
        // none exists here) — never the owner's absolute path.
        openOrReplaceSessionTab({
          sessionId: result.localSessionId,
          sessionName: result.name,
          repoPath: result.repoPath,
        });
        openSession(result.localSessionId, result.name, result.repoPath);
        return "opened";
      } catch (error) {
        if (error instanceof ForkCancelledError) {
          // User dismissed the mandatory pick-your-checkout dialog (or the
          // picked folder didn't match the source repo) — quiet cancel.
          return "noop";
        }
        if (isOrg2SyncErrorCode(error, "ORG2_RETENTION_EXPIRED")) {
          notifyRetentionExpired();
          return "retention-expired";
        }
        if (isOrg2SyncErrorCode(error, "ORG2_REPLAY_NOT_AVAILABLE")) {
          Message.error(t("cloud.sidebar.metadataOnly"));
          return "failed";
        }
        const forkErrorKind = classifyForkOperationError(error);
        log.error("cloud session fork failed", {
          sourceSessionId: remoteSession.sourceSessionId,
          orgId,
          stage: forkErrorKind ?? "unknown",
          error,
        });
        Message.error(
          t(
            forkErrorKind === "replay_unavailable"
              ? "collaboration.session.forkReplayUnavailable"
              : forkErrorKind === "snapshot_incomplete"
                ? "collaboration.session.forkSnapshotIncomplete"
                : forkErrorKind === "agent_unavailable"
                  ? "collaboration.session.forkAgentUnavailable"
                  : forkErrorKind === "backend_registration"
                    ? "collaboration.session.forkBackendRegistrationFailed"
                    : "collaboration.session.forkFailed"
          )
        );
        return "failed";
      } finally {
        endSessionBusy(remoteSession.id);
      }
    },
    [
      beginSessionBusy,
      clearDownloadProgress,
      endSessionBusy,
      freshAccessToken,
      openOrReplaceSessionTab,
      openSession,
      notifyRetentionExpired,
      orgId,
      store,
      t,
      updateSessionBusy,
      upsertDownloadProgress,
    ]
  );

  return {
    replaySession,
    forkSession,
    busySessionRows,
  };
}
