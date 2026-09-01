/**
 * ForkCheckoutPickerDialog — in-app checkout selection for "fork & continue"
 * (strict scope governance): when the fork resolver finds no local checkout
 * of the SOURCE repo, `pickMatchingCheckout` (forkSession.ts) parks a request
 * in `forkCheckoutRequestAtom` and awaits it; this dialog (mounted once next
 * to JoinCloudOrgDialog) lists the workspace repos and lets the user pick —
 * ONLY rows whose git remotes actually include the source repo are
 * selectable, everything else renders disabled with its scope key as the
 * reason. Closing = cancel (fork aborts quietly via ForkCancelledError).
 */
import Modal from "@/src/scaffold/ModalSystem";
import { atom, useAtom } from "jotai";
import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";

import useSharedRepoList from "@src/scaffold/GlobalSpotlight/hooks/data/useSharedRepoList";
import type { RepoItem } from "@src/scaffold/GlobalSpotlight/types";

import { normalizeRepoScopeKey } from "../../collabSyncUtils";
import {
  getShareableScopeKeyVersion,
  peekMatchingOrgRepoScope,
  peekShareableScopeKeys,
  primeShareableScopeKey,
  subscribeShareableScopeKeys,
} from "../../repoScopeResolver";

interface ForkCheckoutRequest {
  /** Normalized scope key of the SOURCE repo the fork must land in. */
  sourceScopeKey: string;
  /** Source session title (dialog context line). */
  sourceTitle: string;
  /** Resolves with the picked local path, or null on cancel. */
  resolve: (localPath: string | null) => void;
}

/** One-shot handoff: fork flow parks a request; the dialog consumes it. */
export const forkCheckoutRequestAtom = atom<ForkCheckoutRequest | null>(null);
forkCheckoutRequestAtom.debugLabel = "forkCheckoutRequestAtom";

function repoScopeKeys(repo: RepoItem): string[] | null | undefined {
  // A workspace row's repo_url is only its primary/display remote and may be
  // the user's fork. Checkout eligibility must use the local checkout's full
  // remote set (origin + upstream + …), exactly like org scope matching.
  if (repo.fs_uri) return peekShareableScopeKeys(repo.fs_uri);
  if (repo.repo_url) {
    const key = normalizeRepoScopeKey(repo.repo_url);
    return key ? [key] : null;
  }
  return null;
}

const ForkCheckoutPickerDialog: React.FC = () => {
  const { t } = useTranslation("navigation");
  const [request, setRequest] = useAtom(forkCheckoutRequestAtom);
  const { repos, repoLoading, loadRepos } = useSharedRepoList("");
  // Re-render when async remote resolutions land in the shared cache.
  React.useSyncExternalStore(
    subscribeShareableScopeKeys,
    getShareableScopeKeyVersion
  );

  useEffect(() => {
    if (!request) return;
    queueMicrotask(() => void loadRepos());
  }, [request, loadRepos]);

  useEffect(() => {
    if (!request) return;
    for (const repo of repos) {
      if (repo.fs_uri) primeShareableScopeKey(repo.fs_uri);
    }
  }, [request, repos]);

  if (!request) return null;
  const targetKey = normalizeRepoScopeKey(request.sourceScopeKey);

  const cancel = () => {
    request.resolve(null);
    setRequest(null);
  };

  return (
    <Modal
      visible
      title={t("collaboration.session.forkPickCheckoutTitle", {
        repo: request.sourceScopeKey,
      })}
      onCancel={cancel}
      footer={null}
      width={520}
    >
      <div className="flex flex-col gap-3">
        <div className="text-[12px] text-text-3">
          {t("collaboration.session.forkPickCheckoutHint", {
            session: request.sourceTitle,
            repo: request.sourceScopeKey,
          })}
        </div>
        <div className="flex max-h-64 flex-col divide-y divide-border-2 overflow-y-auto rounded-xl border border-border-2 bg-bg-2">
          {repos.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-text-3">
              {repoLoading
                ? t("collaboration.repoPicker.loading")
                : t("collaboration.repoPicker.empty")}
            </div>
          ) : (
            repos.map((repo) => {
              const keys = repoScopeKeys(repo);
              const matches = Boolean(
                peekMatchingOrgRepoScope(keys, [targetKey])
              );
              const localPath = repo.fs_uri;
              const selectable = matches && Boolean(localPath);
              return (
                <button
                  key={repo.id}
                  type="button"
                  disabled={!selectable}
                  onClick={() => {
                    if (!selectable || !localPath) return;
                    request.resolve(localPath);
                    setRequest(null);
                  }}
                  className={`flex flex-col px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none focus-visible:ring-inset ${
                    selectable
                      ? "cursor-pointer hover:bg-fill-2"
                      : "cursor-not-allowed opacity-50"
                  }`}
                  data-testid={`fork-checkout-option-${repo.id}`}
                >
                  <span className="truncate text-[12px] text-text-1">
                    {repo.name}
                  </span>
                  <span className="truncate text-[11px] text-text-3">
                    {keys === undefined
                      ? t("collaboration.repoPicker.resolving")
                      : keys === null
                        ? t("collaboration.repoPicker.noRemote")
                        : keys.join(" · ")}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="text-[11px] text-text-3">
          {t("collaboration.session.forkPickCheckoutClone")}
        </div>
      </div>
    </Modal>
  );
};

export default ForkCheckoutPickerDialog;
