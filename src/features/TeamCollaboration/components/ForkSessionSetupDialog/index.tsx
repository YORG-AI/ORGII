import Modal from "@/src/scaffold/ModalSystem";
import { atom, useAtom } from "jotai";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CliAgentTypeSchema } from "@src/api/tauri/rpc/schemas/validation";
import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { getCliTransportLabel } from "@src/config/cliAgents";
import {
  accountHasModel,
  accountModelIds,
  useModelAccountLookup,
} from "@src/hooks/models/useModelAccountLookup";
import { useAgentDefinitions } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentDefinitions";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import useSharedRepoList from "@src/scaffold/GlobalSpotlight/hooks/data/useSharedRepoList";
import type { RepoItem } from "@src/scaffold/GlobalSpotlight/types";

import { normalizeRepoScopeKey } from "../../collabSyncUtils";
import type { ForkExecutionSelection } from "../../engine/collabSyncEngineHelpers";
import {
  getShareableScopeKeyVersion,
  peekMatchingOrgRepoScope,
  peekShareableScopeKeys,
  primeShareableScopeKey,
  subscribeShareableScopeKeys,
} from "../../repoScopeResolver";
import { resolveForkModelPreselection } from "./modelPreselection";

export interface ForkSessionSetupSelection {
  workspaceRepoPath: string | null;
  execution: ForkExecutionSelection;
}

export interface ForkSessionSetupRequest {
  sourceTitle: string;
  sourceScopeKey?: string;
  sourceModel?: string;
  sourceAgentDisplayName?: string;
  sourceAgentDefinitionId?: string;
  allowCliRuntime?: boolean;
  lockSourceAgent?: boolean;
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

function agentDisplayLabel(agent: AgentDefinition): string {
  return agent.description?.trim().length
    ? `${agent.name} · ${agent.description}`
    : agent.name;
}

function agentPrefersModel(
  agent: AgentDefinition,
  model: string | undefined
): boolean {
  if (!model) return false;
  return agent.selectedModelId === model;
}

const ForkSessionSetupForm: React.FC<ForkSessionSetupFormProps> = ({
  request,
  resolve,
}) => {
  const { t } = useTranslation("navigation");
  const { accounts } = useModelAccountLookup();
  const { builtInAgents, agents: customAgents } = useAgentDefinitions();
  const { agents: cliAgents } = useCliAgents({
    enabled: request.allowCliRuntime === true,
  });
  const allAgents = useMemo(
    () => [...builtInAgents, ...customAgents],
    [builtInAgents, customAgents]
  );
  const { repos, repoLoading, loadRepos } = useSharedRepoList({
    enabled: false,
    searchQuery: "",
  });
  const [chosenAccountId, setChosenAccountId] = useState("");
  const [chosenModel, setChosenModel] = useState("");
  const [chosenAgentDefinitionId, setChosenAgentDefinitionId] = useState("");
  const [chosenRuntime, setChosenRuntime] = useState("native");
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
  const sourceAgentDefinitionId = request.sourceAgentDefinitionId;
  const preferredAccount = useMemo(
    () =>
      (sourceModel
        ? runnableAccounts.find((account) =>
            accountHasModel(account, sourceModel)
          )
        : undefined) ?? runnableAccounts[0],
    [sourceModel, runnableAccounts]
  );
  const preferredAgent = useMemo(() => {
    const sourceAgent = sourceAgentDefinitionId
      ? allAgents.find((agent) => agent.id === sourceAgentDefinitionId)
      : undefined;
    if (sourceAgent || (request.lockSourceAgent && sourceAgentDefinitionId)) {
      return sourceAgent;
    }
    if (sourceModel) {
      return allAgents.find((agent) => agentPrefersModel(agent, sourceModel));
    }
    return (
      allAgents.find((agent) => agent.id === "builtin:sde") ?? allAgents[0]
    );
  }, [
    allAgents,
    request.lockSourceAgent,
    sourceAgentDefinitionId,
    sourceModel,
  ]);
  const selectedAgent = useMemo(
    () =>
      allAgents.find(
        (agent) => agent.id === (chosenAgentDefinitionId || preferredAgent?.id)
      ) ?? null,
    [allAgents, chosenAgentDefinitionId, preferredAgent?.id]
  );
  const agentPreferredAccountId = selectedAgent?.selectedAccountId
    ? runnableAccounts.find(
        (account) => account.id === selectedAgent.selectedAccountId
      )?.id
    : undefined;
  const accountId =
    chosenAccountId || agentPreferredAccountId || preferredAccount?.id || "";
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
  const agentOptions = useMemo<SelectOption[]>(
    () =>
      allAgents.map((agent) => ({
        value: agent.id,
        label: agentDisplayLabel(agent),
        triggerLabel: agent.name,
      })),
    [allAgents]
  );
  const runnableCliAgents = useMemo(
    () =>
      cliAgents.flatMap((agent) => {
        const parsed = CliAgentTypeSchema.safeParse(agent.name);
        return agent.installed && agent.supportsGui && parsed.success
          ? [{ agent, cliAgentType: parsed.data }]
          : [];
      }),
    [cliAgents]
  );
  const runtimeOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: "native",
        label: t("collaboration.session.forkSetupRuntimeNative"),
      },
      ...runnableCliAgents.map(({ agent, cliAgentType }) => ({
        value: `cli:${cliAgentType}`,
        label: `${agent.displayName} · ${t(
          "collaboration.session.forkSetupRuntimeCli"
        )} (${getCliTransportLabel(cliAgentType)})`,
        triggerLabel: agent.displayName,
      })),
    ],
    [runnableCliAgents, t]
  );
  const selectedCliAgent = useMemo(() => {
    if (!chosenRuntime.startsWith("cli:")) return null;
    const parsed = CliAgentTypeSchema.safeParse(chosenRuntime.slice(4));
    if (!parsed.success) return null;
    return (
      runnableCliAgents.find(
        (candidate) => candidate.cliAgentType === parsed.data
      ) ?? null
    );
  }, [chosenRuntime, runnableCliAgents]);
  const modelOptions = useMemo<SelectOption[]>(() => {
    if (!selectedAccount) return [];
    return accountModelIds(selectedAccount)
      .filter((modelId) => accountHasModel(selectedAccount, modelId))
      .sort((left, right) => left.localeCompare(right))
      .map((modelId) => ({ value: modelId, label: modelId }));
  }, [selectedAccount]);
  const preferredAgentModel =
    selectedAgent?.selectedModelId &&
    selectedAccount &&
    accountHasModel(selectedAccount, selectedAgent.selectedModelId)
      ? selectedAgent.selectedModelId
      : undefined;
  const model = resolveForkModelPreselection({
    chosenModel,
    // A user pick or a source agent hint pins the agent's own model;
    // otherwise the imported/remote session's model is "the right one".
    agentChoiceExplicit: Boolean(
      chosenAgentDefinitionId || sourceAgentDefinitionId
    ),
    preferredAgentModel,
    sourceModelOnAccount:
      sourceModel &&
      selectedAccount &&
      accountHasModel(selectedAccount, sourceModel)
        ? sourceModel
        : undefined,
    fallbackModel: String(modelOptions[0]?.value ?? ""),
  });
  const targetKey = request.sourceScopeKey
    ? normalizeRepoScopeKey(request.sourceScopeKey)
    : null;
  const workspaceRequired = Boolean(targetKey);
  const nativeExecutionReady =
    Boolean(selectedAccount && accountId && model) &&
    Boolean(selectedAccount && accountHasModel(selectedAccount, model));
  const executionReady = selectedCliAgent
    ? true
    : chosenRuntime === "native" && nativeExecutionReady;
  const canContinue =
    Boolean(selectedAgent) &&
    executionReady &&
    (!workspaceRequired || Boolean(workspaceRepoPath));

  useEffect(() => {
    queueMicrotask(() => void loadRepos());
  }, [loadRepos]);

  useEffect(() => {
    for (const repo of repos) {
      if (repo.fs_uri) primeShareableScopeKey(repo.fs_uri);
    }
  }, [repos]);

  const matchingRepos = repos.filter((repo) => {
    if (!targetKey) return Boolean(repo.fs_uri);
    return Boolean(peekMatchingOrgRepoScope(repoScopeKeys(repo), [targetKey]));
  });
  const sourceAgentLabel =
    request.sourceAgentDisplayName ?? request.sourceTitle;
  const selectedAgentSourceHint = request.sourceAgentDisplayName
    ? `Source agent: ${request.sourceAgentDisplayName}`
    : selectedAgent
      ? `Selected local agent: ${selectedAgent.name}`
      : "";

  const cancel = () => {
    resolve(null);
  };
  const submit = () => {
    if (!canContinue || !selectedAgent) return;
    resolve({
      workspaceRepoPath,
      execution: selectedCliAgent
        ? {
            agentDefinitionId: selectedAgent.id,
            cliAgentType: selectedCliAgent.cliAgentType,
          }
        : {
            agentDefinitionId: selectedAgent.id,
            accountId,
            model,
          },
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

        <div className="flex flex-col gap-2 rounded-xl border border-border-2 bg-bg-2 p-3">
          <span className="text-xs font-medium text-text-1">Source agent</span>
          <div className="text-xs text-text-3">{sourceAgentLabel}</div>
          {selectedAgentSourceHint ? (
            <div className="text-xs text-text-3">{selectedAgentSourceHint}</div>
          ) : null}
        </div>

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

        <div
          className={`grid gap-3 ${
            request.allowCliRuntime ? "grid-cols-2" : "grid-cols-3"
          }`}
        >
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-text-1">
            Agent
            <Select
              value={chosenAgentDefinitionId || preferredAgent?.id || undefined}
              options={agentOptions}
              placeholder="Select agent"
              disabled={request.lockSourceAgent}
              onChange={(value) => {
                setChosenAgentDefinitionId(String(value));
                setChosenAccountId("");
                setChosenModel("");
              }}
              style={{ width: "100%" }}
              dataTestId="fork-setup-agent"
            />
          </label>
          {request.allowCliRuntime ? (
            <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-text-1">
              {t("collaboration.session.forkSetupRuntime")}
              <Select
                value={chosenRuntime}
                options={runtimeOptions}
                onChange={(value) => setChosenRuntime(String(value))}
                style={{ width: "100%" }}
                dataTestId="fork-setup-runtime"
              />
            </label>
          ) : null}
          {!selectedCliAgent ? (
            <>
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
            </>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={cancel}>
            {t("common:actions.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!canContinue}
            data-testid="fork-session-setup-submit"
          >
            {t("common:actions.confirm", { defaultValue: "Continue" })}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export const ForkSessionSetupDialog: React.FC = () => {
  const [request, setRequest] = useAtom(forkSessionSetupRequestAtom);
  const resolve = (selection: ForkSessionSetupSelection | null) => {
    request?.resolve(selection);
    setRequest(null);
  };

  useEffect(() => {
    return () => setRequest(null);
  }, [setRequest]);

  if (!request) return null;
  return <ForkSessionSetupForm request={request} resolve={resolve} />;
};

export default ForkSessionSetupDialog;
