/**
 * AccountInlineEditSection — Inline name/description editor for the
 * AccountInlineExpandedCard "Edit" tab.
 *
 * Replaces the legacy standalone AccountEditForm page. Only name and
 * description are editable here; an InlineAlert directs users to delete and
 * re-add the account if they need to change API keys / credentials.
 *
 * The form body and the Cancel/Save footer are rendered as separate
 * components so the footer sits in the same slot as the other tabs'
 * AccountInlineActionsBar (sibling of InlineCardBody inside
 * InlineCardShell).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ProviderEndpoint } from "@src/api/tauri/rpc/schemas/validation";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Textarea from "@src/components/Textarea";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";
import {
  getOfficialBaseUrl,
  hasEndpointChoice,
  resolveSelectedEndpoint,
  useProviderConfig,
} from "@src/scaffold/WizardSystem/variants/KeyVault/config";

import {
  InlineCardColumnStack,
  InlineCardFooter,
} from "../../shared/InlineCardPrimitives";

interface AccountInlineEditState {
  name: string;
  setName: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  /** Endpoints this account's provider offers; empty when there is no choice. */
  endpoints: ProviderEndpoint[];
  endpointId: string | undefined;
  setEndpointId: (value: string) => void;
  saving: boolean;
  savedAt: number | null;
  canSave: boolean;
  handleSave: () => Promise<void>;
}

/**
 * Owns the edit form state. Pair with {@link AccountInlineEditBody} and
 * {@link AccountInlineEditFooter}.
 *
 * Endpoint choices come from the Rust provider registry, so any provider that
 * declares more than one endpoint (Zhipu, MiniMax, Bedrock, OpenCode…) gets a
 * picker here without further wiring.
 */
export function useAccountInlineEditState(
  account: KeyVaultAccount,
  onSave: (name: string, description: string, baseUrl?: string) => Promise<void>
): AccountInlineEditState {
  const { config: providerConfig } = useProviderConfig(account.modelType);
  const endpoints = useMemo(
    () => providerConfig?.endpoints ?? [],
    [providerConfig?.endpoints]
  );
  const offersEndpointChoice = hasEndpointChoice(endpoints);
  const protocol =
    account.protocol ?? providerConfig?.defaultProtocol ?? "openai";

  const savedEndpointId = resolveSelectedEndpoint(
    endpoints,
    account.baseUrl
  )?.id;

  const [name, setName] = useState(account.name);
  const [description, setDescription] = useState(account.description ?? "");
  const [endpointId, setEndpointId] = useState<string | undefined>(
    savedEndpointId
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setName(account.name);
    setDescription(account.description ?? "");
    setEndpointId(savedEndpointId);
  }, [
    account.id,
    account.name,
    account.description,
    account.baseUrl,
    savedEndpointId,
  ]);

  const trimmedName = name.trim();
  const isDirty =
    trimmedName !== account.name ||
    description.trim() !== (account.description ?? "").trim() ||
    (offersEndpointChoice && endpointId !== savedEndpointId);
  const canSave = isDirty && trimmedName.length > 0 && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const selectedEndpoint = endpoints.find(
        (entry) => entry.id === endpointId
      );
      await onSave(
        trimmedName,
        description.trim(),
        offersEndpointChoice
          ? getOfficialBaseUrl(selectedEndpoint, protocol)
          : undefined
      );
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }, [
    canSave,
    description,
    endpointId,
    endpoints,
    offersEndpointChoice,
    onSave,
    protocol,
    trimmedName,
  ]);

  useEffect(() => {
    if (savedAt == null) return;
    const handle = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(handle);
  }, [savedAt]);

  return {
    name,
    setName,
    description,
    setDescription,
    endpoints,
    endpointId,
    setEndpointId,
    saving,
    savedAt,
    canSave,
    handleSave,
  };
}

interface AccountInlineEditBodyProps {
  state: AccountInlineEditState;
}

export const AccountInlineEditBody: React.FC<AccountInlineEditBodyProps> = ({
  state,
}) => {
  const { t } = useTranslation("integrations");
  const {
    name,
    setName,
    description,
    setDescription,
    endpoints,
    endpointId,
    setEndpointId,
  } = state;

  const endpointOptions: SelectionGridOption<string>[] = endpoints.map(
    (entry) => ({ key: entry.id, label: entry.label })
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <InlineCardColumnStack>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-1 text-[12px] font-semibold text-text-1">
            {t("keyVault.accountName")}
            <span className="ml-0.5 text-danger-6">*</span>
          </span>
          <Input
            value={name}
            onChange={setName}
            placeholder={t("keyVault.accountNamePlaceholder")}
            spellCheck={false}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-semibold text-text-1">
            {t("keyVault.descriptionOptional")}
          </span>
          <Textarea
            value={description}
            onChange={setDescription}
            placeholder={t("keyVault.descriptionPlaceholder")}
            rows={2}
          />
        </div>
        {hasEndpointChoice(endpoints) ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] font-semibold text-text-1">
              {t("keyVault.endpoint")}
            </span>
            <SelectionGrid
              options={endpointOptions}
              selected={endpointId ?? null}
              onSelect={setEndpointId}
              cardVariant="subtle"
            />
          </div>
        ) : null}
      </InlineCardColumnStack>

      <InlineAlert type="info">{t("keyVault.edit.apiChangeHint")}</InlineAlert>
    </div>
  );
};

interface AccountInlineEditFooterProps {
  state: AccountInlineEditState;
  onCancel: () => void;
}

export const AccountInlineEditFooter: React.FC<
  AccountInlineEditFooterProps
> = ({ state, onCancel }) => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation();
  const { saving, savedAt, canSave, handleSave } = state;

  return (
    <InlineCardFooter>
      {savedAt != null ? (
        <span className="mr-auto text-[12px] text-success-6">
          {t("keyVault.edit.saved")}
        </span>
      ) : null}
      <Button variant="secondary" size="small" onClick={onCancel}>
        {tCommon("actions.cancel")}
      </Button>
      <Button
        variant="primary"
        size="small"
        onClick={handleSave}
        disabled={!canSave}
        loading={saving}
      >
        {tCommon("actions.save")}
      </Button>
    </InlineCardFooter>
  );
};
