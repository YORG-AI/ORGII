/**
 * GatewayAgentCard
 *
 * Configures the Gateway singleton's dedicated LLM model + API key account.
 * Sits at the top of the Channels list: a single Gateway routes messages from
 * every channel (Telegram, Feishu, WeCom, WeChat…), so its model/account pair
 * is channel-agnostic and intentionally not per-account.
 *
 * The selection is independent from any foreground session's model to avoid
 * coupling the background router to whatever the user happens to have picked
 * in the current session.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { setGatewayModel } from "@src/api/tauri/agent/tools";
import { rpc } from "@src/api/tauri/rpc";
import type { KeyInfo } from "@src/api/tauri/rpc/schemas/validation";
import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select/types";
import Switch from "@src/components/Switch";
import { loadSharedLocalKeys } from "@src/hooks/keyVault/sharedLocalKeyStore";
import { createLogger } from "@src/hooks/logger";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

const log = createLogger("GatewayAgentCard");

interface GatewayBinding {
  accountId: string | null;
  model: string | null;
  groupSessionsPerUser: boolean;
}

async function loadBinding(): Promise<GatewayBinding> {
  const cfg = (await rpc.integrations.get()) as {
    channels?: {
      gateway?: { accountId?: string; model?: string };
      groupSessionsPerUser?: boolean;
    };
  };
  const gateway = cfg.channels?.gateway;
  return {
    accountId: gateway?.accountId ?? null,
    model: gateway?.model ?? null,
    groupSessionsPerUser: cfg.channels?.groupSessionsPerUser ?? true,
  };
}

const GatewayAgentCard: React.FC = () => {
  const { t: tIntegrations } = useTranslation("integrations");

  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [groupPerUser, setGroupPerUser] = useState<boolean>(true);
  const [savedBinding, setSavedBinding] = useState<GatewayBinding>({
    accountId: null,
    model: null,
    groupSessionsPerUser: true,
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [listed, binding] = await Promise.all([
          loadSharedLocalKeys(),
          loadBinding(),
        ]);
        if (cancelled) return;
        setKeys(listed.filter((key) => key.enabled));
        setAccountId(binding.accountId);
        setModel(binding.model);
        setGroupPerUser(binding.groupSessionsPerUser);
        setSavedBinding(binding);
      } catch (err: unknown) {
        if (!cancelled) {
          log.error("[GatewayAgentCard] load failed", err);
          setErrorMessage(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const accountOptions = useMemo<SelectOption[]>(
    () =>
      keys.map((key) => ({
        value: key.id,
        label: key.name ?? key.id,
      })),
    [keys]
  );

  const selectedAccount = useMemo(
    () => keys.find((key) => key.id === accountId) ?? null,
    [keys, accountId]
  );

  const modelOptions = useMemo<SelectOption[]>(() => {
    if (!selectedAccount) return [];
    const pool =
      selectedAccount.enabled_models.length > 0
        ? selectedAccount.enabled_models
        : selectedAccount.available_models;
    return pool.map((name) => ({ value: name, label: name }));
  }, [selectedAccount]);

  const handleAccountChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const next = typeof value === "string" ? value : null;
      setAccountId(next);
      setModel(null);
    },
    []
  );

  const handleModelChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const next = typeof value === "string" ? value : null;
      setModel(next);
    },
    []
  );

  const dirty =
    accountId !== savedBinding.accountId ||
    model !== savedBinding.model ||
    groupPerUser !== savedBinding.groupSessionsPerUser;

  const handleGroupPerUserToggle = useCallback(async (checked: boolean) => {
    setGroupPerUser(checked);
    try {
      await rpc.integrations.updatePatch({
        patch: { channels: { groupSessionsPerUser: checked } },
      });
      setSavedBinding((prev) => ({
        ...prev,
        groupSessionsPerUser: checked,
      }));
    } catch (err: unknown) {
      log.error("[GatewayAgentCard] toggle group-per-user failed", err);
      setGroupPerUser(!checked);
    }
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setErrorMessage(null);
    try {
      await setGatewayModel(accountId, model);
      setSavedBinding((prev) => ({ ...prev, accountId, model }));
    } catch (err: unknown) {
      log.error("[GatewayAgentCard] save failed", err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [accountId, model]);

  const handleClear = useCallback(async () => {
    setSaving(true);
    setErrorMessage(null);
    try {
      await setGatewayModel(null, null);
      setAccountId(null);
      setModel(null);
      setSavedBinding((prev) => ({ ...prev, accountId: null, model: null }));
    } catch (err: unknown) {
      log.error("[GatewayAgentCard] clear failed", err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const hasBinding = Boolean(savedBinding.accountId && savedBinding.model);

  return (
    <div className="mb-3">
      <SectionContainer>
        <SectionRow
          label={tIntegrations("channels.gateway.title")}
          description={tIntegrations("channels.gateway.description")}
        >
          {hasBinding && (
            <span className="rounded-full bg-success-1 px-2 py-0.5 text-[11px] font-medium text-success-6">
              {tIntegrations("channels.gateway.statusReady")}
            </span>
          )}
          {!hasBinding && !loading && (
            <span className="rounded-full bg-warning-1 px-2 py-0.5 text-[11px] font-medium text-warning-6">
              {tIntegrations("channels.gateway.statusUnconfigured")}
            </span>
          )}
        </SectionRow>

        <SectionRow label={tIntegrations("channels.gateway.account")} required>
          <Select
            value={accountId ?? undefined}
            options={accountOptions}
            onChange={handleAccountChange}
            placeholder={tIntegrations("channels.gateway.accountPlaceholder")}
            loading={loading}
            allowClear
            onClear={() => handleAccountChange("")}
            showSearch
            size="default"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>

        <SectionRow label={tIntegrations("channels.gateway.model")} required>
          <Select
            value={model ?? undefined}
            options={modelOptions}
            onChange={handleModelChange}
            placeholder={tIntegrations("channels.gateway.modelPlaceholder")}
            disabled={!accountId || modelOptions.length === 0}
            allowClear
            onClear={() => handleModelChange("")}
            showSearch
            size="default"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>

        <SectionRow
          label={tIntegrations("channels.gateway.groupPerUser")}
          description={tIntegrations("channels.gateway.groupPerUserDesc")}
        >
          <Switch
            checked={groupPerUser}
            onCheckedChange={handleGroupPerUserToggle}
          />
        </SectionRow>

        {errorMessage && (
          <SectionRow showHeader={false}>
            <div className="text-[12px] text-danger-6">{errorMessage}</div>
          </SectionRow>
        )}

        <SectionRow showHeader={false}>
          <div className="flex w-full justify-end">
            <div className={SECTION_ACTION_GAP_CLASSES}>
              {hasBinding && (
                <Button
                  size="small"
                  variant="tertiary"
                  disabled={saving}
                  onClick={handleClear}
                >
                  {tIntegrations("common:actions.clear")}
                </Button>
              )}
              <Button
                size="small"
                variant="primary"
                loading={saving}
                disabled={!dirty || saving || !accountId || !model}
                onClick={handleSave}
              >
                {tIntegrations("common:actions.save")}
              </Button>
            </div>
          </div>
        </SectionRow>
      </SectionContainer>
    </div>
  );
};

export default GatewayAgentCard;
