/**
 * CloudShareImportDialog — consumer side of the cloud share deep link
 * (migration 0012): confirmation dialog → resolveCloudSessionShare(token) →
 * read-only import through the shared segments importer → openSession.
 *
 * Guests (not signed in, not a member) are first-class: the token IS the
 * credential — resolve and every segments fetch ride the anon TICKET tier,
 * the imported copy lands as an `external_history` session with no `orgId`
 * (sidebar Personal area), and no org records are created. Signed-in
 * members go through the exact same path; the token authenticates the read
 * regardless.
 *
 * The pending atom itself is the dialog state: it stays set while the
 * confirmation is open and is consumed (cleared) exactly once on close, so a
 * re-render can never replay the hand-off. All per-link results are keyed by
 * the share token, so a newer link invalidates stale resolve/import state.
 * Modeled on CollabShareImportDialog (minus the combined-invite CTA — cloud
 * share links carry only the token).
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { importRemoteSession } from "@src/features/TeamCollaboration/engine/collabSyncEngineHelpers";
import { resolveForkWorkspacePath } from "@src/features/TeamCollaboration/forkSession";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { openOrReplaceSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { buildCloudSessionFetchClient } from "./org2CloudBackendAdapter";
import {
  consumeOrg2CloudPendingShareAtom,
  org2CloudPendingShareAtom,
} from "./org2CloudPendingShareAtom";
import { resolveCloudSessionShare } from "./org2CloudSharesClient";

interface ResolveState {
  token: string;
  session: RemoteTeammateSessionMetadata | null;
  failed: boolean;
}

interface ImportState {
  token: string;
  status: "importing" | "failed";
}

const CloudShareImportDialog: React.FC = () => {
  const { t } = useTranslation("navigation");
  const { openSession } = useSessionView();
  const openOrReplaceSessionTab = useSetAtom(
    openOrReplaceSessionInChatPanelTabAtom
  );
  const share = useAtomValue(org2CloudPendingShareAtom);
  const consumePendingShare = useSetAtom(consumeOrg2CloudPendingShareAtom);

  const [resolveState, setResolveState] = useState<ResolveState | null>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const activeTokenRef = useRef<string | null>(null);
  const importGenerationRef = useRef(0);
  const shareToken = share?.shareToken ?? null;

  // Commit the current hand-off before a user can interact with the painted
  // dialog. A layout effect keeps ref access outside render while still
  // invalidating an older import before the browser paints the new token.
  useLayoutEffect(() => {
    activeTokenRef.current = shareToken;
    importGenerationRef.current += 1;
  }, [shareToken]);

  // Resolve the token to the session projection (title/owner shown in the
  // confirmation). State updates only happen in the async callback, keyed by
  // token.
  useEffect(() => {
    if (!shareToken) return;
    let cancelled = false;
    resolveCloudSessionShare(shareToken)
      .then((session) => {
        if (!cancelled) {
          setResolveState({ token: shareToken, session, failed: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Terminal resolution cancels any in-flight visual state. Without
          // this, the dialog can show an invalid/revoked error beside a stale
          // spinning Import button.
          importGenerationRef.current += 1;
          setImportState(null);
          setResolveState({ token: shareToken, session: null, failed: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  const resolved =
    share && resolveState?.token === share.shareToken ? resolveState : null;
  const currentImport =
    share && importState?.token === share.shareToken ? importState : null;

  // Resolve failure = the token itself is invalid/expired/revoked/aged-out
  // (the server's answer is deliberately opaque). Import failure is
  // DIFFERENT and retryable: a transient network error, or a valid share
  // whose owner hasn't pushed event segments yet.
  const resolveFailed = Boolean(resolved?.failed);
  const isImporting = currentImport?.status === "importing";
  const importFailed = currentImport?.status === "failed" && !resolveFailed;
  const canImport =
    Boolean(resolved?.session) && !resolveFailed && !isImporting;

  const handleClose = useCallback(() => {
    activeTokenRef.current = null;
    importGenerationRef.current += 1;
    setImportState(null);
    // One-shot consume: clears the atom so nothing can replay this link.
    consumePendingShare();
  }, [consumePendingShare]);

  const handleImport = useCallback(async () => {
    if (!share || !resolved?.session || resolveFailed || isImporting) return;
    const token = share.shareToken;
    const generation = ++importGenerationRef.current;
    setImportState({ token, status: "importing" });
    try {
      const localRepoPath =
        (await resolveForkWorkspacePath(resolved.session)) ?? undefined;
      const result = await importRemoteSession({
        // TICKET tier: anon fetch client — the share token authenticates
        // every segments read, member or not.
        client: buildCloudSessionFetchClient(null),
        orgId: resolved.session.orgId,
        remoteSession: resolved.session,
        shareToken: token,
        workspaceRepoPath: localRepoPath,
      });
      if (
        activeTokenRef.current !== token ||
        importGenerationRef.current !== generation
      ) {
        return;
      }
      if (!result) {
        setImportState({ token, status: "failed" });
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
        activeTokenRef.current === token &&
        importGenerationRef.current === generation
      ) {
        setImportState({ token, status: "failed" });
      }
    }
  }, [
    handleClose,
    isImporting,
    openOrReplaceSessionTab,
    openSession,
    resolveFailed,
    resolved,
    share,
  ]);

  return (
    <Modal
      visible={share !== null}
      title={t("cloud.share.incomingTitle")}
      onCancel={handleClose}
      footer={null}
      width={440}
    >
      <div
        className="flex flex-col gap-3"
        data-testid="cloud-share-import-dialog"
      >
        {!resolved && !resolveFailed ? (
          <div className="text-[12px] text-text-3">
            {t("cloud.share.incomingResolving")}
          </div>
        ) : null}

        {resolveFailed ? (
          <div
            className="rounded-lg bg-danger-1 px-3 py-2 text-[12px] text-danger-6"
            data-testid="cloud-share-import-resolve-error"
          >
            {t("cloud.share.incomingError")}
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
            variant={resolveFailed ? "primary" : "secondary"}
            onClick={handleClose}
          >
            {t("cloud.share.incomingDismiss")}
          </Button>
          {!resolveFailed ? (
            <Button
              htmlType="button"
              variant="primary"
              loading={isImporting}
              disabled={!canImport}
              onClick={() => void handleImport()}
              data-testid="cloud-share-import-confirm"
            >
              {t("cloud.share.incomingImport")}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default CloudShareImportDialog;
