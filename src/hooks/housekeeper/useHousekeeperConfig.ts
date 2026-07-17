import { useMemo } from "react";

import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { useKeyVault } from "@src/hooks/keyVault";
import { useSetting } from "@src/hooks/settings/useSettings";

import {
  HOUSEKEEPER_DEFAULT_MODEL,
  HOUSEKEEPER_SAFE_CONTEXT_TOKENS,
} from "./constants";

function pushUnique(values: string[], value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed || values.includes(trimmed)) return;
  values.push(trimmed);
}

export function getHousekeeperModelCandidates(
  account: KeyVaultAccount | null | undefined
): string[] {
  if (!account) return [];
  const candidates: string[] = [];
  for (const model of account.enabledModels ?? [])
    pushUnique(candidates, model);
  for (const model of account.availableModels ?? [])
    pushUnique(candidates, model);
  for (const variant of account.modelVariants ?? []) {
    pushUnique(candidates, variant.model);
  }
  for (const variant of account.defaultVariants ?? []) {
    pushUnique(candidates, variant.model);
  }
  return candidates;
}

function firstMiniCPMModel(account: KeyVaultAccount | null | undefined) {
  return getHousekeeperModelCandidates(account).find((model) =>
    model.toLowerCase().includes("minicpm")
  );
}

function isLocalBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function isHousekeeperAccount(account: KeyVaultAccount): boolean {
  if (!account.enabled) return false;
  if (account.modelType === "vllm_api") return true;
  return (
    account.modelType === "openai_api" &&
    isLocalBaseUrl(account.baseUrl) &&
    Boolean(firstMiniCPMModel(account))
  );
}

export function useHousekeeperConfig() {
  const [enabled, setEnabled] = useSetting("housekeeper.enabled");
  const [accountId, setAccountId] = useSetting("housekeeper.accountId");
  const [model, setModel] = useSetting("housekeeper.model");
  const [contextLimitTokens, setContextLimitTokens] = useSetting(
    "housekeeper.contextLimitTokens"
  );
  const [promptPolishEnabled, setPromptPolishEnabled] = useSetting(
    "housekeeper.features.promptPolish"
  );
  const [stepExplainEnabled, setStepExplainEnabled] = useSetting(
    "housekeeper.features.stepExplain"
  );
  const [uiControlEnabled, setUiControlEnabled] = useSetting(
    "housekeeper.features.uiControl"
  );
  const [contextCompactEnabled, setContextCompactEnabled] = useSetting(
    "housekeeper.features.contextCompact"
  );
  const keyVault = useKeyVault({ autoLoad: true });

  const vllmAccounts = useMemo(
    () => keyVault.accounts.filter(isHousekeeperAccount),
    [keyVault.accounts]
  );

  const configuredAccount = useMemo(
    () => vllmAccounts.find((account) => account.id === accountId) ?? null,
    [accountId, vllmAccounts]
  );

  const autoAccount = useMemo(() => {
    const readyMiniCPM = vllmAccounts.find(
      (account) => account.status === "ready" && firstMiniCPMModel(account)
    );
    if (readyMiniCPM) return readyMiniCPM;
    return (
      vllmAccounts.find((account) => firstMiniCPMModel(account)) ??
      vllmAccounts[0] ??
      null
    );
  }, [vllmAccounts]);

  const resolvedAccount = configuredAccount ?? autoAccount;
  const accountModel = firstMiniCPMModel(resolvedAccount);
  const configuredModel = model.trim();
  const resolvedModel =
    !configuredModel || configuredModel === HOUSEKEEPER_DEFAULT_MODEL
      ? accountModel || HOUSEKEEPER_DEFAULT_MODEL
      : configuredModel;
  const resolvedAccountId = resolvedAccount?.id ?? null;
  const isConfigured = Boolean(enabled && resolvedAccountId && resolvedModel);

  return {
    enabled,
    setEnabled,
    accountId,
    setAccountId,
    model,
    setModel,
    contextLimitTokens: contextLimitTokens || HOUSEKEEPER_SAFE_CONTEXT_TOKENS,
    setContextLimitTokens,
    features: {
      promptPolish: promptPolishEnabled,
      stepExplain: stepExplainEnabled,
      uiControl: uiControlEnabled,
      contextCompact: contextCompactEnabled,
    },
    setFeatures: {
      promptPolish: setPromptPolishEnabled,
      stepExplain: setStepExplainEnabled,
      uiControl: setUiControlEnabled,
      contextCompact: setContextCompactEnabled,
    },
    keyVault,
    vllmAccounts,
    configuredAccount,
    autoAccount,
    resolvedAccount,
    resolvedAccountId,
    resolvedModel,
    isConfigured,
  };
}
