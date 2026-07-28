/**
 * KeyVaultWizard — Wizard for adding BYOK keys and CLI accounts in Key Vault.
 *
 * Single-step flow for every provider — API key, guided login, generic, etc.
 * `ApiSetup` handles provider selection, credentials, validation, and the
 * consolidated model table for enabled / custom rows in one screen.
 *
 * Listing / pricing / pool / publish flows are not part of the OSS build.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ModelType } from "@src/api/types/keys";
import { isApiKeyProvider } from "@src/assets/providers";
import { WizardShell } from "@src/scaffold/WizardSystem/primitives";

import { useProviderRegistry } from "../hooks/useProviderRegistry";
import { useWizard } from "../hooks/useWizard";
import type { KeyVaultWizardProps } from "../types";
import ApiSetup from "./ApiSetup";

const KeyVaultWizard: React.FC<KeyVaultWizardProps> = ({
  onSubmit,
  onCancel,
  loading = false,
  initialAgentType,
  title,
  initialData,
  autoStartCodexLogin = false,
  primaryProvidersOnly = true,
  existingAccountNames,
}) => {
  const { t } = useTranslation("integrations");
  const { unifiedProviders } = useProviderRegistry({
    primaryOnly: primaryProvidersOnly,
  });

  const getDefaultNameBase = useCallback(
    (modelType: ModelType) => {
      for (const provider of unifiedProviders) {
        const hasMatchingVariant = provider.variants.some(
          (variant) => variant.modelType === modelType
        );
        if (hasMatchingVariant) return provider.label;
      }
      return undefined;
    },
    [unifiedProviders]
  );

  const computedInitialData = useMemo(
    () => ({
      ...(initialAgentType ? { agent_type: initialAgentType } : {}),
      ...initialData,
    }),
    [initialAgentType, initialData]
  );

  const { data, updateData, submit } = useWizard({
    onSubmit,
    initialData: computedInitialData,
    existingAccountNames,
    getDefaultNameBase,
  });
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserCloseSignal, setBrowserCloseSignal] = useState(0);

  const handleClose = useCallback(() => {
    if (browserOpen) {
      setBrowserCloseSignal((signal) => signal + 1);
      return;
    }
    onCancel();
  }, [browserOpen, onCancel]);

  const isCli =
    !!data.agent_type && !isApiKeyProvider(data.agent_type as string);

  const resolvedTitle =
    title ??
    (isCli
      ? t("keyVault.addCliAgent", "Add Agent")
      : t("keyVault.addAccount", "Add Account"));

  return (
    <WizardShell
      title={resolvedTitle}
      onCancel={handleClose}
      testId="key-vault-wizard"
      closeTestId="key-vault-wizard-close"
    >
      <ApiSetup
        data={data}
        onChange={updateData}
        onNext={submit}
        onCancel={handleClose}
        primaryProvidersOnly={primaryProvidersOnly}
        existingAccountNames={existingAccountNames}
        submitLabel={t("common:actions.done")}
        loading={loading}
        browserCloseSignal={browserCloseSignal}
        onBrowserStateChange={setBrowserOpen}
        autoStartCodexLogin={autoStartCodexLogin}
      />
    </WizardShell>
  );
};

export default KeyVaultWizard;
