/** One confirmation surface for a fork's local workspace, account, and model. */
import Modal from "@/src/scaffold/ModalSystem";
import { atom, useAtom } from "jotai";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import {
  accountHasModel,
  accountModelIds,
  useModelAccountLookup,
} from "@src/hooks/models/useModelAccountLookup";
import useSharedRepoList from "@src/scaffold/GlobalSpotlight/hooks/data/useSharedRepoList";
import type { RepoItem } from "@src/scaffold/GlobalSpotlight/types";

import { normalizeRepoScopeKey } from "../../collabSyncUtils";
import type { ForkExecutionSelection } from "../../engine/collabSyncEngineHelpers";
import {
  getShareableScopeKeyVersion,
  peekShareableScopeKeys,
  primeShareableScopeKey,
  subscribeShareableScopeKeys,
} from "../../repoScopeResolver";

export interface ForkSessionSetupSelection {
  workspaceRepoPath: string | null;
  execution: ForkExecutionSelection;
}

export interface ForkSessionSetupRequest {
  sourceTitle: string;
  sourceScopeKey?: string;
  sourceModel?: string;
  resolve: (selection: ForkSessionSetupSelection | null) => void;
}

export const forkSessionSetupRequestAtom = atom<ForkSessionSetupRequest | null>(
  null
);
forkSessionSetupRequestAtom.debugLabel = "forkSessionSetupRequestAtom";

function repoScopeKeys(repo: RepoItem): string[] | null | undefined {
  if (repo.fs_uri) return peekShareableScopeKeys(repo.fs_uri);
  if (repo.repo_url) {
    const key = normalizeRepoScopeKey(repo.repo_url);
    return key ? [key] : null;
  }
  return null;
}

interface ForkSessionSetupFormProps {
  request: ForkSessionSetupRequest;
  resolve: (selection: ForkSessionSetupSelection | null) => void;
}

const ForkSessionSetupForm: React.FC<ForkSessionSetupFormProps> = ({
  request,
  resolve,
}) => {
  const { t } = useTranslation("navigation");
  const { accounts } = useModelAccountLookup();
  const { repos, repoLoading, loadRepos } = useSharedRepoList({
    enabled: false,
    searchQuery: "",
  });
  const [chosenAccountId, setChosenAccountId] = useState("");
  const [chosenModel, setChosenModel] = useState("");
  const [workspaceRepoPath, setWorkspaceRepoPath] = useState<string | null>(
    null
  );

  React.useSyncExternalStore(
    subscribeShareableScopeKeys,
    getShareableScopeKeyVersion
  );

  const runnableAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.enabled &&
          account.status === "ready" &&
          account.hasKey &&
          account.supportsRustAgents !== false
      ),
    [accounts]
  );
  const sourceModel = request.sourceModel;
  const preferredAccount = useMemo(
    () =>
      (sourceModel
        ? runnableAccounts.find((account) =>
            accountHasModel(account, sourceModel)
          )
        : undefined) ?? runnableAccounts[0],
    [sourceModel, runnableAccounts]
  );
  const accountId = chosenAccountId || preferredAccount?.id || "";
  const selectedAccount = runnableAccounts.find(
    (account) => account.id === accountId
  );
  const accountOptions = useMemo<SelectOption[]>(
    () =>
      runnableAccounts.map((account) => ({
        value: account.id,
        label: `${account.name} · ${account.modelType}`,
        triggerLabel: account.name,
      })),
    [runnableAccounts]
  );
  const modelOptions = useMemo<SelectOption[]>(() => {
    if (!selectedAccount) return [];
    return accountModelIds(selectedAccount)
      .filter((modelId) => accountHasModel(selectedAccount, modelId))
      .sort((left, right) => left.localeCompare(right))
      .map((modelId) => ({ value: modelId, label: modelId }));
  }, [selectedAccount]);
  const model =
    chosenModel ||
    (sourceModel &&
    selectedAccount &&
    accountHasModel(selectedAccount, sourceModel)
      ? sourceModel
      : String(modelOptions[0]?.value ?? ""));

  useEffect(() => {
    queueMicrotask(() => void loadRepos());
  }, [loadRepos]);

  useEffect(() => {
    for (const repo of repos) {
      if (repo.fs_uri) primeShareableScopeKey(repo.fs_uri);
    }
  }, [repos]);

  const targetKey = request.sourceScopeKey
    ? normalizeRepoScopeKey(request.sourceScopeKey)
    : null;
  const matchingRepos = repos.filter((repo) => {
    if (!targetKey) return Boolean(repo.fs_uri);
    return repoScopeKeys(repo)?.some(
      (key) => normalizeRepoScopeKey(key) === targetKey
    );
  });
  const workspaceRequired = Boolean(targetKey);
  const canContinue =
    Boolean(selectedAccount && accountId && model) &&
    (!workspaceRequired || Boolean(workspaceRepoPath));

  const cancel = () => {
    resolve(null);
  };
  const submit = () => {
    if (!canContinue) return;
    resolve({
      workspaceRepoPath,
      execution: { accountId, model },
    });
  };

  return (
    <Modal
      visible
      title={t("collaboration.session.forkSetupTitle")}
      onCancel={cancel}
      footer={null}
      width={560}
    >
      <div className="flex flex-col gap-4" data-testid="fork-session-setup">
        <p className="text-xs text-text-3">
          {t("collaboration.session.forkSetupHint", {
            session: request.sourceTitle,
          })}
        </p>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-text-1">
            {t("collaboration.session.forkSetupWorkspace")}
          </span>
          <div className="flex max-h-48 flex-col divide-y divide-border-2 overflow-y-auto rounded-xl border border-border-2 bg-bg-2">
            {matchingRepos.length === 0 ? (
              <div className="px-3 py-3 text-xs text-text-3">
                {repoLoading
                  ? t("collaboration.repoPicker.loading")
                  : workspaceRequired
                    ? t("collaboration.session.forkPickCheckoutClone")
                    : t("collaboration.repoPicker.empty")}
              </div>
            ) : (
              matchingRepos.map((repo) => {
                const selected = workspaceRepoPath === repo.fs_uri;
                return (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => setWorkspaceRepoPath(repo.fs_uri ?? null)}
                    className={`flex flex-col px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-6/30 ${
                      selected ? "bg-fill-2" : "hover:bg-fill-2"
                    }`}
                    data-testid={`fork-setup-workspace-${repo.id}`}
                  >
                    <span className="truncate text-xs text-text-1">
                      {repo.name}
                    </span>
                    <span className="truncate text-xs text-text-3">
                      {repo.fs_uri}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {!workspaceRequired && (
            <Button
              size="small"
              variant="tertiary"
              appearance="ghost"
              onClick={() => setWorkspaceRepoPath(null)}
            >
              {t("collaboration.session.forkSetupNoWorkspace")}
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-text-1">
            {t("collaboration.session.forkSetupAccount")}
            <Select
              value={accountId || undefined}
              options={accountOptions}
              placeholder={t("collaboration.session.forkSetupAccount")}
              onChange={(value) => {
                setChosenAccountId(String(value));
                setChosenModel("");
              }}
              style={{ width: "100%" }}
              dataTestId="fork-setup-account"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-text-1">
            {t("collaboration.session.forkSetupModel")}
            <Select
              value={model || undefined}
              options={modelOptions}
              placeholder={t("collaboration.session.forkSetupModel")}
              disabled={!selectedAccount}
              showSearch
              onChange={(value) => setChosenModel(String(value))}
              style={{ width: "100%" }}
              dataTestId="fork-setup-model"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={cancel}>
            {t("common:actions.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            variant="primary"
            disabled={!canContinue}
            onClick={submit}
            data-testid="fork-setup-submit"
          >
            {t("collaboration.session.forkSetupContinue")}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

const ForkSessionSetupDialog: React.FC = () => {
  const [request, setRequest] = useAtom(forkSessionSetupRequestAtom);
  if (!request) return null;
  return (
    <ForkSessionSetupForm
      request={request}
      resolve={(selection) => {
        request.resolve(selection);
        setRequest(null);
      }}
    />
  );
};

export default ForkSessionSetupDialog;
