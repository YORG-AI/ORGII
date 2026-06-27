import { atom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  CLI_AGENT,
  type CliAgentType,
  type ModelType,
  NATIVE_HARNESS_TYPE,
} from "@src/api/tauri/rpc/schemas/validation";
import { KEY_SOURCE, isHostedKey } from "@src/api/tauri/session";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { type KeyVaultAccount, useKeyVault } from "@src/hooks/keyVault";
import { useValidatedLastPair } from "@src/hooks/models/useValidatedLastPair";
import {
  creatorDefaultModelSelectionAtom,
  extractModelPair,
} from "@src/store/session/creatorDefaultModelAtom";
import {
  cliAgentTypeAtom,
  dispatchCategoryAtom,
  selectedAgentOrgIdAtom,
} from "@src/store/session/creatorStateAtom";

type AgentOrgMemberDraftConfig = Pick<
  AdvancedConfig,
  "agentOrgMemberOverrides" | "applyAgentOrgMemberOverridesForFuture"
>;

export const agentOrgMemberDraftConfigByOrgAtom = atom<
  Record<string, AgentOrgMemberDraftConfig>
>({});

export const agentOrgMemberDraftConfigAtom = atom(
  (get): AgentOrgMemberDraftConfig => {
    const orgId = get(selectedAgentOrgIdAtom);
    if (!orgId) return {};
    return get(agentOrgMemberDraftConfigByOrgAtom)[orgId] ?? {};
  },
  (get, set, next: AgentOrgMemberDraftConfig) => {
    const orgId = get(selectedAgentOrgIdAtom);
    if (!orgId) return;
    const currentByOrg = get(agentOrgMemberDraftConfigByOrgAtom);
    set(agentOrgMemberDraftConfigByOrgAtom, {
      ...currentByOrg,
      [orgId]: next,
    });
  }
);

interface UseAdvancedConfigResult {
  advancedConfig: AdvancedConfig;
  setAdvancedConfig: (
    nextOrUpdater: AdvancedConfig | ((prev: AdvancedConfig) => AdvancedConfig)
  ) => void;
  setLastModelSelection: ReturnType<
    typeof useSetAtom<typeof creatorDefaultModelSelectionAtom>
  >;
}

/**
 * Derives AdvancedConfig from the canonical model selection atom.
 * Provides a stable setter that extracts only the model pair for storage.
 */
export function useAdvancedConfig(): UseAdvancedConfigResult {
  const dispatchCategory = useAtomValue(dispatchCategoryAtom);
  const atomCliAgentType = useAtomValue(cliAgentTypeAtom);
  const { getAccount } = useKeyVault({ autoLoad: true });

  const lastModelSelection = useValidatedLastPair();
  const memberDraftConfig = useAtomValue(agentOrgMemberDraftConfigAtom);
  const setMemberDraftConfig = useSetAtom(agentOrgMemberDraftConfigAtom);
  const setLastModelSelection = useSetAtom(creatorDefaultModelSelectionAtom);

  const advancedConfig = useMemo<AdvancedConfig>(() => {
    if (!lastModelSelection) {
      return atomCliAgentType
        ? {
            cliAgentType: atomCliAgentType as CliAgentType,
            ...memberDraftConfig,
          }
        : { ...memberDraftConfig };
    }

    if (isHostedKey(lastModelSelection.keySource)) {
      return {
        keySource: KEY_SOURCE.HOSTED,
        cliAgentType:
          lastModelSelection.cliAgentType ?? atomCliAgentType ?? undefined,
        tier: lastModelSelection.tier,
        listingModel: lastModelSelection.listingModel,
        listingModelDisplay: lastModelSelection.listingModelDisplay,
        listingModelType: lastModelSelection.listingModelType,
        listingName: lastModelSelection.listingName,
        selectedSourceLabel: lastModelSelection.selectedSourceLabel,
        selectedSourceModelType: lastModelSelection.selectedSourceModelType,
        ...memberDraftConfig,
      };
    }

    const selectedAccount: KeyVaultAccount | undefined =
      lastModelSelection.selectedAccountId
        ? getAccount(lastModelSelection.selectedAccountId)
        : undefined;
    const selectedSourceModelType = lastModelSelection.selectedSourceModelType;
    const nativeHarnessType =
      dispatchCategory === "rust_agent" &&
      (selectedAccount?.nativeHarnessType ||
        selectedSourceModelType === CLI_AGENT.CURSOR)
        ? (selectedAccount?.nativeHarnessType ?? NATIVE_HARNESS_TYPE.CURSOR)
        : undefined;

    return {
      keySource: KEY_SOURCE.OWN,
      cliAgentType: atomCliAgentType ?? undefined,
      provider: lastModelSelection.provider,
      model: lastModelSelection.model,
      nativeHarnessType,
      agent: lastModelSelection.provider as ModelType | undefined,
      selectedAccountId: lastModelSelection.selectedAccountId,
      selectedSourceLabel: lastModelSelection.selectedSourceLabel,
      selectedSourceModelType,
      ...memberDraftConfig,
    };
  }, [
    lastModelSelection,
    atomCliAgentType,
    dispatchCategory,
    getAccount,
    memberDraftConfig,
  ]);

  const setAdvancedConfig = useCallback(
    (
      nextOrUpdater: AdvancedConfig | ((prev: AdvancedConfig) => AdvancedConfig)
    ) => {
      const resolved =
        typeof nextOrUpdater === "function"
          ? nextOrUpdater(advancedConfig)
          : nextOrUpdater;
      setMemberDraftConfig({
        agentOrgMemberOverrides: resolved.agentOrgMemberOverrides,
        applyAgentOrgMemberOverridesForFuture:
          resolved.applyAgentOrgMemberOverridesForFuture,
      });
      const pair = extractModelPair(resolved);
      setLastModelSelection(pair);
    },
    [advancedConfig, setLastModelSelection, setMemberDraftConfig]
  );

  return { advancedConfig, setAdvancedConfig, setLastModelSelection };
}
