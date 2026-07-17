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
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { importRemoteSession } from "@src/features/TeamCollaboration/engine/collabSyncEngineHelpers";
import {
  ForkCancelledError,
  forkTeammateSession,
  resolveForkWorkspacePath,
} from "@src/features/TeamCollaboration/forkSession";
import { createLogger } from "@src/hooks/logger";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { openOrReplaceSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { buildCloudSessionFetchClient } from "./org2CloudBackendAdapter";
import { ensureFreshSession } from "./org2CloudClient";
import { isOrg2SyncErrorCode } from "./org2CloudSyncClient";

const log = createLogger("useCloudSessionActions");

export type CloudSessionActionOutcome =
  | "opened"
  /** The click raced past the server-side retention filter — show upgrade. */
  | "retention-expired"
  | "failed"
  /** Row not actionable (nothing published / another action in flight). */
  | "noop";

export interface UseCloudSessionActionsResult {
  replaySession: (
    remoteSession: RemoteTeammateSessionMetadata
  ) => Promise<CloudSessionActionOutcome>;
  forkSession: (
    remoteSession: RemoteTeammateSessionMetadata
  ) => Promise<CloudSessionActionOutcome>;
  /** Row id (`remoteSession.id`) with a replay/fork in flight, else null. */
  busySessionRowId: string | null;
  /** Last row id that hit ORG2_RETENTION_EXPIRED, else null. */
  retentionExpiredRowId: string | null;
}

/** Per-org replay/fork actions for cloud remote-session rows. */
export function useCloudSessionActions(
  orgId: string | null
): UseCloudSessionActionsResult {
  const { t } = useTranslation("navigation");
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const { openSession } = useSessionView();
  const openOrReplaceSessionTab = useSetAtom(
    openOrReplaceSessionInChatPanelTabAtom
  );
  const [busySessionRowId, setBusySessionRowId] = useState<string | null>(null);
  const [retentionExpiredRowId, setRetentionExpiredRowId] = useState<
    string | null
  >(null);
  // Latest auth via ref so token-refresh writes don't recreate callbacks
  // (same idiom as the panel fetch effects).
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  /** Fresh JWT for a user action (same refresh idiom as the panel). */
  const freshAccessToken = useCallback(async (): Promise<string | null> => {
    const current = authRef.current;
    if (!current) return null;
    const fresh = await ensureFreshSession(current);
    if (!fresh) return null;
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth]);

  // Read-only replay: same shared importer the self-hosted panel row uses,
  // only the segments-fetch client differs. Rows are server-filtered to the
  // retention window, but a click can race past it — ORG2_RETENTION_EXPIRED
  // then surfaces as an upgrade prompt, not a generic failure.
  const replaySession = useCallback(
    async (
      remoteSession: RemoteTeammateSessionMetadata
    ): Promise<CloudSessionActionOutcome> => {
      if (!orgId || remoteSession.eventsEpoch === undefined) return "noop";
      if (busySessionRowId) return "noop";
      setBusySessionRowId(remoteSession.id);
      try {
        const accessToken = await freshAccessToken();
        if (!accessToken) {
          Message.error(t("cloud.orgPanel.importError"));
          return "failed";
        }
        // Resolve before import so the importer can translate owner-side
        // absolute paths while building the local Session Blame index.
        const localRepoPath =
          (await resolveForkWorkspacePath(remoteSession)) ?? undefined;
        const result = await importRemoteSession({
          client: buildCloudSessionFetchClient(accessToken),
          orgId,
          remoteSession,
          workspaceRepoPath: localRepoPath,
        });
        if (result) {
          openOrReplaceSessionTab({
            sessionId: result.localSessionId,
            sessionName: remoteSession.title,
            repoPath: localRepoPath,
          });
          openSession(
            result.localSessionId,
            remoteSession.title,
            localRepoPath
          );
          return "opened";
        }
        // null ⇒ owner has published no segments (metadata-only card).
        Message.error(t("cloud.orgPanel.importError"));
        return "failed";
      } catch (error) {
        if (isOrg2SyncErrorCode(error, "ORG2_RETENTION_EXPIRED")) {
          setRetentionExpiredRowId(remoteSession.id);
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
        setBusySessionRowId(null);
      }
    },
    [
      busySessionRowId,
      freshAccessToken,
      openOrReplaceSessionTab,
      openSession,
      orgId,
      t,
    ]
  );

  // Fork & continue: same full relay as the self-hosted ⑂ row action —
  // engine fork + backend row registration + first-send context handoff.
  const forkSession = useCallback(
    async (
      remoteSession: RemoteTeammateSessionMetadata
    ): Promise<CloudSessionActionOutcome> => {
      if (!orgId || remoteSession.eventsEpoch === undefined) return "noop";
      if (busySessionRowId) return "noop";
      setBusySessionRowId(remoteSession.id);
      try {
        const accessToken = await freshAccessToken();
        if (!accessToken) {
          Message.error(t("collaboration.session.forkFailed"));
          return "failed";
        }
        const result = await forkTeammateSession({
          client: buildCloudSessionFetchClient(accessToken),
          orgId,
          remoteSession,
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
          setRetentionExpiredRowId(remoteSession.id);
          return "retention-expired";
        }
        if (isOrg2SyncErrorCode(error, "ORG2_REPLAY_NOT_AVAILABLE")) {
          Message.error(t("cloud.sidebar.metadataOnly"));
          return "failed";
        }
        log.error("cloud session fork failed", error);
        Message.error(t("collaboration.session.forkFailed"));
        return "failed";
      } finally {
        setBusySessionRowId(null);
      }
    },
    [
      busySessionRowId,
      freshAccessToken,
      openOrReplaceSessionTab,
      openSession,
      orgId,
      t,
    ]
  );

  return {
    replaySession,
    forkSession,
    busySessionRowId,
    retentionExpiredRowId,
  };
}
