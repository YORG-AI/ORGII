/**
 * useProviderSelection
 *
 * Manages provider/variant selection state for the ApiSetup wizard step.
 * Owns: selectedProviderKey, agent-type reset/set callbacks, grid/select
 * option derivations, and setup-method option building.
 *
 * Extracted from ApiSetup.tsx to keep it under 600 lines.
 */
import { Globe, Key, Keyboard, LogIn, ScanSearch } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import type { CliAgentType, ModelType } from "@src/api/types/keys";
import type { SelectionGridOption } from "@src/scaffold/WizardSystem/primitives";

import {
  buildProviderGridOptions,
  buildProviderSelectOptions,
  buildVariantGridOptions,
  buildVariantSelectOptions,
} from "../components/providerOptions";
import { type UnifiedProvider, useProviderRegistry } from "../config";
import type { ApiSetupProps } from "../types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UseProviderSelectionOptions {
  data: ApiSetupProps["data"];
  onChange: ApiSetupProps["onChange"];
  primaryProvidersOnly?: boolean;
}

export interface UseProviderSelectionReturn {
  unifiedProviders: UnifiedProvider[];
  selectedProviderKey: string | null;
  selectedProvider: UnifiedProvider | undefined;
  hasMultipleVariants: boolean;
  providerGridOptions: ReturnType<typeof buildProviderGridOptions>;
  providerSelectOptions: ReturnType<typeof buildProviderSelectOptions>;
  variantGridOptions: ReturnType<typeof buildVariantGridOptions>;
  variantSelectOptions: ReturnType<typeof buildVariantSelectOptions>;
  complexMethodOptions: SelectionGridOption[];
  isComplex: boolean;
  handleProviderSelect: (providerKey: string) => void;
  handleProviderClear: () => void;
  handleVariantSelect: (agentType: string) => void;
  handleVariantClear: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useProviderSelection({
  data,
  onChange,
  primaryProvidersOnly = false,
}: UseProviderSelectionOptions): UseProviderSelectionReturn {
  const { t } = useTranslation("integrations");
  const { unifiedProviders, modelTypeToProviderKey } = useProviderRegistry({
    primaryOnly: primaryProvidersOnly,
  });

  const [selectedProviderKeyOverride, setSelectedProviderKeyOverride] =
    useState<string | null>(null);

  const selectedProviderKey = data.agent_type
    ? (modelTypeToProviderKey[data.agent_type] ?? null)
    : selectedProviderKeyOverride;

  const selectedProvider = useMemo(
    () => unifiedProviders.find((p) => p.key === selectedProviderKey),
    [unifiedProviders, selectedProviderKey]
  );

  const hasMultipleVariants = (selectedProvider?.variants.length ?? 0) > 1;

  const resetAgentType = useCallback(() => {
    onChange({
      agent_type: "" as ModelType,
      raw_key_input: "",
      cursor_session_token: "",
      oauth_session_token: "",
      auth_method: undefined,
      validated: false,
      available_models: [],
      enabled_models: [],
      quota_info: undefined,
      extracted_api_key: undefined,
      extracted_base_url: undefined,
      protocol: undefined,
      setup_method: undefined,
    });
  }, [onChange]);

  const setAgentType = useCallback(
    (agentValue: string) => {
      if (data.agent_type !== agentValue) {
        const typedAgent = agentValue as CliAgentType;
        const selectedVariant = selectedProvider?.variants.find(
          (variant) => variant.modelType === agentValue
        );
        onChange({
          agent_type: typedAgent,
          raw_key_input: "",
          cursor_session_token: "",
          oauth_session_token: "",
          auth_method: undefined,
          validated: false,
          available_models: [],
          enabled_models: [],
          quota_info: undefined,
          extracted_api_key: undefined,
          extracted_base_url: undefined,
          protocol: selectedVariant?.defaultProtocol,
          setup_method:
            typedAgent === CLI_AGENT.CURSOR
              ? "guided"
              : typedAgent === CLI_AGENT.KIRO
                ? "autodetect"
                : typedAgent === CLI_AGENT.CLAUDE_CODE ||
                    typedAgent === CLI_AGENT.CODEX
                  ? "signin"
                  : undefined,
        });
      }
    },
    [data.agent_type, onChange, selectedProvider]
  );

  const handleProviderSelect = useCallback(
    (providerKey: string) => {
      const provider = unifiedProviders.find((p) => p.key === providerKey);
      if (!provider) return;
      setSelectedProviderKeyOverride(providerKey);
      if (provider.variants.length === 1) {
        setAgentType(provider.variants[0].modelType);
      } else {
        resetAgentType();
      }
    },
    [unifiedProviders, setAgentType, resetAgentType]
  );

  const handleProviderClear = useCallback(() => {
    setSelectedProviderKeyOverride(null);
    resetAgentType();
  }, [resetAgentType]);

  const handleVariantSelect = useCallback(
    (agentType: string) => setAgentType(agentType),
    [setAgentType]
  );

  const handleVariantClear = useCallback(
    () => resetAgentType(),
    [resetAgentType]
  );

  const providerGridOptions = useMemo(
    () => buildProviderGridOptions(unifiedProviders),
    [unifiedProviders]
  );
  const providerSelectOptions = useMemo(
    () => buildProviderSelectOptions(unifiedProviders),
    [unifiedProviders]
  );
  const variantGridOptions = useMemo(
    () => buildVariantGridOptions(selectedProvider, t),
    [selectedProvider, t]
  );
  const variantSelectOptions = useMemo(
    () => buildVariantSelectOptions(selectedProvider, t),
    [selectedProvider, t]
  );

  const isComplex =
    !!data.agent_type &&
    (data.agent_type === CLI_AGENT.CURSOR ||
      data.agent_type === CLI_AGENT.CODEX ||
      data.agent_type === CLI_AGENT.COPILOT ||
      data.agent_type === CLI_AGENT.KIRO ||
      data.agent_type === CLI_AGENT.CLAUDE_CODE);

  const complexMethodOptions = useMemo((): SelectionGridOption[] => {
    if (!isComplex) return [];
    const agentType = data.agent_type as string;
    if (agentType === CLI_AGENT.CURSOR) {
      return [
        { key: "guided", label: t("keyVault.guidedSetup"), icon: Globe },
        {
          key: "autodetect",
          label: t("keyVault.autodetect"),
          icon: ScanSearch,
        },
        { key: "enter_token", label: t("keyVault.enterToken"), icon: Keyboard },
      ];
    }
    if (agentType === CLI_AGENT.COPILOT) {
      return [
        { key: "has_key", label: t("keyVault.copilotHasKey"), icon: Key },
        { key: "create", label: t("keyVault.copilotCreateKey"), icon: Globe },
      ];
    }
    if (agentType === CLI_AGENT.KIRO) {
      return [
        {
          key: "autodetect",
          label: t("keyVault.autodetect"),
          icon: ScanSearch,
        },
        { key: "signin", label: t("keyVault.signIn"), icon: LogIn },
      ];
    }
    if (agentType === CLI_AGENT.CLAUDE_CODE) {
      return [{ key: "signin", label: t("keyVault.signIn"), icon: LogIn }];
    }
    if (agentType === CLI_AGENT.CODEX) {
      return [
        { key: "signin", label: t("keyVault.signIn"), icon: LogIn },
        {
          key: "autodetect",
          label: t("keyVault.autodetect"),
          icon: ScanSearch,
        },
        { key: "enter_token", label: t("keyVault.enterToken"), icon: Keyboard },
      ];
    }
    return [];
  }, [isComplex, data.agent_type, t]);

  return {
    unifiedProviders,
    selectedProviderKey,
    selectedProvider,
    hasMultipleVariants,
    providerGridOptions,
    providerSelectOptions,
    variantGridOptions,
    variantSelectOptions,
    complexMethodOptions,
    isComplex,
    handleProviderSelect,
    handleProviderClear,
    handleVariantSelect,
    handleVariantClear,
  };
}
