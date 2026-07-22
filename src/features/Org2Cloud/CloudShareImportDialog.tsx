/**
 * CloudShareImportDialog — consumer side of the cloud share deep link
 * (migration 0012): confirmation dialog → resolveCloudSessionShare(token) →
 * read-only import through the shared segments importer → openSession.
 *
 * Registered non-members are first-class: a user JWT proves registration and
 * the token grants access without creating an org membership. The imported
 * copy lands as an `external_history` session with no `orgId` (sidebar
 * Personal area), and no org records are created.
 *
 * The pending atom itself is the dialog state: it stays set while the
 * confirmation is open and is consumed (cleared) exactly once on close. Each
 * hand-off has a monotonically increasing attemptId, so reopening the same
 * token can never reuse an earlier resolve/import result.
 * Modeled on CollabShareImportDialog (minus the combined-invite CTA — cloud
 * share links carry a token plus non-secret endpoint provenance).
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import Button from "@src/components/Button";
import { ROUTES } from "@src/config/routes";
import { importRemoteSession } from "@src/features/TeamCollaboration/engine/collabSyncEngineHelpers";
import { resolveForkWorkspacePath } from "@src/features/TeamCollaboration/forkSession";
import { useAppNavigation } from "@src/hooks/navigation";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { openOrReplaceSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";

import {
  type CloudShareResolveErrorKind,
  classifyCloudShareResolveError,
  findLocalCloudShareSource,
} from "./cloudShareImportModel";
import type { CloudEndpoint } from "./config";
import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { buildCloudSessionWirePageClient } from "./org2CloudBackendAdapter";
import { ensureFreshSession } from "./org2CloudClient";
import {
  consumeOrg2CloudPendingShareAtom,
  org2CloudPendingShareAtom,
} from "./org2CloudPendingShareAtom";
import {
  requireCloudShareAuthEndpoint,
  resolveCloudShareEndpoint,
} from "./org2CloudShareEndpoint";
import { resolveCloudSessionShare } from "./org2CloudSharesClient";

interface ResolveState {
  attemptId: number;
  cycle: number;
  session: RemoteTeammateSessionMetadata | null;
  endpoint: CloudEndpoint | null;
  error: CloudShareResolveErrorKind | null;
}

interface ImportState {
  attemptId: number;
  status: "importing" | "failed";
}

const CloudShareImportDialog: React.FC = () => {
  const { t } = useTranslation("navigation");
  const { goToSettings } = useAppNavigation();
  const location = useLocation();
  const { openSession } = useSessionView();
  const openOrReplaceSessionTab = useSetAtom(
    openOrReplaceSessionInChatPanelTabAtom
  );
  const share = useAtomValue(org2CloudPendingShareAtom);
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const consumePendingShare = useSetAtom(consumeOrg2CloudPendingShareAtom);
  const sessions = useAtomValue(sessionsAtom);

  const [resolveState, setResolveState] = useState<ResolveState | null>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [resolveCycle, setResolveCycle] = useState(0);
  const activeAttemptRef = useRef<number | null>(null);
  const importGenerationRef = useRef(0);
  const importAbortRef = useRef<AbortController | null>(null);
  const attemptId = share?.attemptId ?? null;
  const onWorkstation = location.pathname.startsWith(
    ROUTES.workStation.base.path
  );

  // Commit the current hand-off before a user can interact with the painted
  // dialog. A layout effect keeps ref access outside render while still
  // invalidating an older import before the browser paints the new token.
  useLayoutEffect(() => {
    activeAttemptRef.current = attemptId;
    importGenerationRef.current += 1;
    importAbortRef.current?.abort();
    importAbortRef.current = null;
  }, [attemptId]);

  // Resolve the token to the session projection (title/owner shown in the
  // confirmation). Resolve and segment fetches share one endpoint snapshot.
  // State updates are keyed by attempt + retry cycle, never by token alone.
  useEffect(() => {
    if (!share || !auth) return;
    let cancelled = false;
    const abortController = new AbortController();
    const currentAttemptId = share.attemptId;
    const currentCycle = resolveCycle;
    const currentAuth = auth;
    void (async () => {
      try {
        const fresh = await ensureFreshSession(currentAuth, {
          onRefreshRejected: () =>
            setAuth((latest) => (latest === currentAuth ? null : latest)),
        });
        if (!fresh) throw new TypeError("Cloud session refresh failed");
        if (!commitRefreshedAuth(setAuth, currentAuth, fresh)) return;
        const endpoint = requireCloudShareAuthEndpoint(
          resolveCloudShareEndpoint(share.endpoint),
          fresh.supabaseUrl
        );
        const session = await resolveCloudSessionShare(
          fresh.accessToken,
          share.shareToken,
          endpoint,
          abortController.signal
        );
        if (!cancelled) {
          setResolveState({
            attemptId: currentAttemptId,
            cycle: currentCycle,
            session,
            endpoint,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          // Terminal resolution cancels any in-flight visual state. Without
          // this, the dialog can show an invalid/revoked error beside a stale
          // spinning Import button.
          importGenerationRef.current += 1;
          setImportState(null);
          setResolveState({
            attemptId: currentAttemptId,
            cycle: currentCycle,
            session: null,
            endpoint: null,
            error: classifyCloudShareResolveError(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [auth, resolveCycle, setAuth, share]);

  const resolved =
    auth &&
    share &&
    resolveState?.attemptId === share.attemptId &&
    resolveState.cycle === resolveCycle
      ? resolveState
      : null;
  const currentImport =
    share && importState?.attemptId === share.attemptId ? importState : null;

  // Resolve failure = the token itself is invalid/expired/revoked/aged-out
  // (the server's answer is deliberately opaque). Import failure is
  // DIFFERENT and retryable: a transient network error, or a valid share
  // whose owner hasn't pushed event segments yet.
  const resolveError = resolved?.error ?? null;
  const resolveFailed = resolveError !== null;
  const isImporting = currentImport?.status === "importing";
  const importFailed = currentImport?.status === "failed" && !resolveFailed;
  const localSource = resolved?.session
    ? findLocalCloudShareSource(sessions, resolved.session)
    : null;
  const canImport =
    Boolean(auth) &&
    Boolean(resolved?.session && resolved.endpoint) &&
    !resolveFailed &&
    !isImporting;

  const handleClose = useCallback(() => {
    activeAttemptRef.current = null;
    importGenerationRef.current += 1;
    // Real cancellation, not result-ignoring: stop the network read, the
    // bounded decode and the durable apply of any in-flight import.
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    setImportState(null);
    // One-shot consume: clears the atom so nothing can replay this link.
    consumePendingShare();
  }, [consumePendingShare]);

  // Preserve the pending share during the sign-in detour. The dialog is
  // hidden off the Workstation route and re-opens with the same one-shot
  // capability after authentication completes.
  const handleOpenSettings = useCallback(() => {
    goToSettings({ section: "collaboration" });
  }, [goToSettings]);

  const handleImport = useCallback(async () => {
    if (
      !share ||
      !auth ||
      !resolved?.session ||
      !resolved.endpoint ||
      resolveFailed ||
      isImporting
    ) {
      return;
    }
    const token = share.shareToken;
    const currentAttemptId = share.attemptId;
    const generation = ++importGenerationRef.current;
    importAbortRef.current?.abort();
    const abortController = new AbortController();
    importAbortRef.current = abortController;
    setImportState({ attemptId: currentAttemptId, status: "importing" });
    try {
      const currentAuth = auth;
      const fresh = await ensureFreshSession(currentAuth, {
        onRefreshRejected: () =>
          setAuth((latest) => (latest === currentAuth ? null : latest)),
      });
      if (!fresh) throw new Error("Cloud session refresh failed");
      if (!commitRefreshedAuth(setAuth, currentAuth, fresh)) {
        setImportState(null);
        return;
      }
      const localRepoPath =
        (await resolveForkWorkspacePath(resolved.session)) ?? undefined;
      const result = await importRemoteSession({
        // The JWT proves registration; the share token authorizes every
        // segments read without requiring source-org membership.
        client: buildCloudSessionWirePageClient(
          fresh.accessToken,
          resolved.endpoint
        ),
        orgId: resolved.session.orgId,
        remoteSession: resolved.session,
        sourceEndpointUrl: resolved.endpoint.supabaseUrl,
        shareToken: token,
        shareEndpointUrl: resolved.endpoint.supabaseUrl,
        workspaceRepoPath: localRepoPath,
        signal: abortController.signal,
      });
      if (
        activeAttemptRef.current !== currentAttemptId ||
        importGenerationRef.current !== generation
      ) {
        return;
      }
      if (!result) {
        setImportState({ attemptId: currentAttemptId, status: "failed" });
        return;
      }
      openOrReplaceSessionTab({
        sessionId: result.localSessionId,
        sessionName: resolved.session.title,
        repoPath: localRepoPath,
      });
      openSession(result.localSessionId, resolved.session.title, localRepoPath);
      handleClose();
    } catch {
      if (
        activeAttemptRef.current === currentAttemptId &&
        importGenerationRef.current === generation
      ) {
        setImportState({ attemptId: currentAttemptId, status: "failed" });
      }
    }
  }, [
    auth,
    handleClose,
    isImporting,
    openOrReplaceSessionTab,
    openSession,
    resolveFailed,
    resolved,
    setAuth,
    share,
  ]);

  const handleOpenExisting = useCallback(() => {
    if (!localSource) return;
    const sessionName = localSource.name ?? resolved?.session?.title;
    openOrReplaceSessionTab({
      sessionId: localSource.session_id,
      sessionName,
      repoPath: localSource.repoPath,
    });
    openSession(localSource.session_id, sessionName, localSource.repoPath);
    handleClose();
  }, [
    handleClose,
    localSource,
    openOrReplaceSessionTab,
    openSession,
    resolved,
  ]);

  const handleRetryResolve = useCallback(() => {
    importGenerationRef.current += 1;
    setImportState(null);
    setResolveCycle((cycle) => cycle + 1);
  }, []);

  const resolveErrorMessage = resolveError
    ? t(
        resolveError === "invalid"
          ? "cloud.share.incomingError"
          : resolveError === "endpoint_mismatch"
            ? "cloud.share.incomingEndpointMismatch"
            : resolveError === "connection"
              ? "cloud.share.incomingConnectionError"
              : resolveError === "incompatible"
                ? "cloud.share.incomingIncompatibleError"
                : "cloud.share.incomingServerError"
      )
    : null;
  const canRetryResolve =
    resolveError === "connection" || resolveError === "server";

  return (
    <Modal
      visible={share !== null && onWorkstation}
      title={t("cloud.share.incomingTitle")}
      onCancel={handleClose}
      footer={null}
      width={440}
    >
      <div
        className="flex flex-col gap-3"
        data-testid="cloud-share-import-dialog"
      >
        {!auth ? (
          <div
            className="rounded-lg bg-fill-1 px-3 py-2 text-[12px] text-text-3"
            data-testid="cloud-share-import-sign-in-required"
          >
            {t("cloud.orgManagement.join.signInFirst")}
          </div>
        ) : null}

        {auth && !resolved && !resolveFailed ? (
          <div
            className="text-[12px] text-text-3"
            role="status"
            aria-live="polite"
          >
            {t("cloud.share.incomingResolving")}
          </div>
        ) : null}

        {resolveFailed ? (
          <div
            className="rounded-lg bg-danger-1 px-3 py-2 text-[12px] text-danger-6"
            data-testid="cloud-share-import-resolve-error"
            data-error-kind={resolveError ?? undefined}
            role="alert"
          >
            {resolveErrorMessage}
          </div>
        ) : null}

        {resolved?.session && !resolveFailed ? (
          <div className="rounded-xl border border-border-2 bg-bg-2 px-3 py-3">
            <div className="text-[13px] font-semibold text-text-1">
              {resolved.session.title}
            </div>
            <div className="mt-1 text-[12px] text-text-3">
              {t("cloud.share.incomingOwner")}:{" "}
              {resolved.session.ownerDisplayName}
            </div>
            {resolved.session.repoPath ? (
              <div className="mt-0.5 truncate text-[11px] text-text-4">
                {resolved.session.repoPath}
              </div>
            ) : null}
          </div>
        ) : null}

        {localSource && !resolveFailed ? (
          <div
            className="rounded-lg bg-fill-1 px-3 py-2 text-[12px] text-text-2"
            data-testid="cloud-share-import-existing-session"
            role="status"
          >
            {t("cloud.share.incomingAlreadyOnDevice")}
          </div>
        ) : null}

        {importFailed ? (
          <div
            className="rounded-lg bg-fill-1 px-3 py-2 text-[12px] text-text-3"
            data-testid="cloud-share-import-retry-error"
          >
            {t("cloud.share.incomingRetryHint")}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            htmlType="button"
            variant={
              resolveFailed && !canRetryResolve ? "primary" : "secondary"
            }
            onClick={handleClose}
          >
            {t("cloud.share.incomingDismiss")}
          </Button>
          {canRetryResolve ? (
            <Button
              htmlType="button"
              variant="primary"
              onClick={handleRetryResolve}
              data-testid="cloud-share-import-retry-resolve"
            >
              {t("cloud.share.incomingRetry")}
            </Button>
          ) : null}
          {!auth ? (
            <Button
              htmlType="button"
              variant="primary"
              onClick={handleOpenSettings}
              data-testid="cloud-share-import-sign-in"
            >
              {t("cloud.orgManagement.join.openSettings")}
            </Button>
          ) : !resolveFailed ? (
            <Button
              htmlType="button"
              variant="primary"
              loading={isImporting}
              disabled={!canImport}
              onClick={
                localSource ? handleOpenExisting : () => void handleImport()
              }
              data-testid="cloud-share-import-confirm"
            >
              {t(
                localSource
                  ? "cloud.share.incomingOpenExisting"
                  : "cloud.share.incomingImport"
              )}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default CloudShareImportDialog;
