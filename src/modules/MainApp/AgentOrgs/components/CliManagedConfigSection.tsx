import { AlertTriangle, RotateCcw, Save, ShieldCheck } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { CliConfigManagedStatus } from "@src/api/tauri/rpc/schemas/agentOrgs";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import { formatAgentType } from "@src/assets/providers";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import StatusDot from "@src/components/StatusDot";
import TabPill from "@src/components/TabPill";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_PATH_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import type { AvailableCliAgent } from "../types";

type CliConfigMode = "default" | "orgii_managed";
type PendingAction = "apply" | "forceApply" | "restore" | "forceRestore";

const DEFAULT_PROXY_URL = "http://127.0.0.1:17888";

function accountLabel(account: KeyVaultAccount): string {
  const name = account.name || account.apiKeyPreview || account.authMethod;
  return `${name} - ${formatAgentType(account.modelType)}`;
}

function modelIdsFor(account: KeyVaultAccount | undefined): string[] {
  if (!account) return [];
  const models =
    account.enabledModels && account.enabledModels.length > 0
      ? account.enabledModels
      : (account.availableModels ?? []);
  return Array.from(new Set(models.filter(Boolean)));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface CliManagedConfigSectionProps {
  agent: AvailableCliAgent;
  credentials: KeyVaultAccount[];
  onOpenCredentials: () => void;
}

const CliManagedConfigSection: React.FC<CliManagedConfigSectionProps> = ({
  agent,
  credentials,
  onOpenCredentials,
}) => {
  const { t } = useTranslation("integrations");
  const [status, setStatus] = useState<CliConfigManagedStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [draftMode, setDraftMode] = useState<CliConfigMode>("default");
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [proxyUrl, setProxyUrl] = useState(DEFAULT_PROXY_URL);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );

  const tr = useCallback(
    (key: string, defaultValue: string) => t(key, { defaultValue }),
    [t]
  );

  const selectedAccount = useMemo(
    () => credentials.find((account) => account.id === selectedKeyId),
    [credentials, selectedKeyId]
  );

  const accountOptions = useMemo(
    () =>
      credentials.map((account) => ({
        label: accountLabel(account),
        value: account.id,
      })),
    [credentials]
  );

  const modelIds = useMemo(
    () => modelIdsFor(selectedAccount),
    [selectedAccount]
  );

  const modelOptions = useMemo(() => {
    const values = new Set(modelIds);
    if (selectedModel) values.add(selectedModel);
    return Array.from(values).map((model) => ({ label: model, value: model }));
  }, [modelIds, selectedModel]);

  const loadStatus = useCallback(async () => {
    if (agent.name !== CLI_AGENT.CODEX) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const nextStatus = await rpc.agentOrgs.managedConfig.getStatus({
        agentName: agent.name,
      });
      setStatus(nextStatus);
      setDraftMode(nextStatus.mode);
      const nextKeyId =
        nextStatus.selectedKeyId ??
        credentials.find((account) => account.enabled !== false)?.id ??
        credentials[0]?.id ??
        "";
      const nextAccount = credentials.find(
        (account) => account.id === nextKeyId
      );
      const nextModels = modelIdsFor(nextAccount);
      setSelectedKeyId(nextKeyId);
      setSelectedModel(nextStatus.selectedModel ?? nextModels[0] ?? "");
      setProxyUrl(nextStatus.proxyUrl ?? DEFAULT_PROXY_URL);
    } catch (err) {
      Message.error({
        content: errMessage(err),
        duration: 3000,
      });
    } finally {
      setLoading(false);
    }
  }, [agent.name, credentials]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!selectedKeyId && credentials.length > 0) {
      const fallback = credentials.find((account) => account.enabled !== false);
      setSelectedKeyId((fallback ?? credentials[0]).id);
      return;
    }

    if (selectedKeyId && !selectedAccount) {
      setSelectedKeyId(credentials[0]?.id ?? "");
    }
  }, [credentials, selectedAccount, selectedKeyId]);

  const applyManaged = useCallback(
    async (force: boolean) => {
      setPendingAction(force ? "forceApply" : "apply");
      try {
        const nextStatus = await rpc.agentOrgs.managedConfig.enableOrgiiManaged(
          {
            agentName: agent.name,
            keyId: selectedKeyId || null,
            provider: selectedAccount?.modelType ?? null,
            model: selectedModel || null,
            proxyUrl: proxyUrl || null,
            force,
          }
        );
        setStatus(nextStatus);
        setDraftMode(nextStatus.mode);
        Message.success({
          content: tr(
            "agentOrgs.cliManagedConfig.applySuccess",
            "ORGII managed config applied"
          ),
        });
      } catch (err) {
        Message.error({
          content: errMessage(err),
          duration: 3000,
        });
      } finally {
        setPendingAction(null);
      }
    },
    [agent.name, proxyUrl, selectedAccount, selectedKeyId, selectedModel, tr]
  );

  const restoreDefault = useCallback(
    async (force: boolean) => {
      if (status?.mode === "default" && !force) {
        setDraftMode("default");
        return;
      }

      setPendingAction(force ? "forceRestore" : "restore");
      try {
        const nextStatus = await rpc.agentOrgs.managedConfig.restoreDefault({
          agentName: agent.name,
          force,
        });
        setStatus(nextStatus);
        setDraftMode(nextStatus.mode);
        Message.success({
          content: tr(
            "agentOrgs.cliManagedConfig.restoreSuccess",
            "Default config restored"
          ),
        });
      } catch (err) {
        Message.error({
          content: errMessage(err),
          duration: 3000,
        });
      } finally {
        setPendingAction(null);
      }
    },
    [agent.name, status?.mode, tr]
  );

  const handleModeChange = useCallback(
    (mode: string) => {
      const nextMode: CliConfigMode =
        mode === "orgii_managed" ? "orgii_managed" : "default";
      setDraftMode(nextMode);
      if (nextMode === "default" && status?.mode === "orgii_managed") {
        void restoreDefault(false);
      }
    },
    [restoreDefault, status?.mode]
  );

  const handleAccountChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const nextKeyId = String(value);
      const nextAccount = credentials.find(
        (account) => account.id === nextKeyId
      );
      const nextModels = modelIdsFor(nextAccount);
      setSelectedKeyId(nextKeyId);
      setSelectedModel(nextModels[0] ?? "");
    },
    [credentials]
  );

  if (agent.name !== CLI_AGENT.CODEX) return null;

  if (loading) {
    return (
      <SectionContainer
        title={tr("agentOrgs.cliManagedConfig.title", "CLI config mode")}
      >
        <Placeholder variant="loading" />
      </SectionContainer>
    );
  }

  if (status && !status.supported) return null;

  const targetFile = status?.targetFiles[0];
  const managedActive = draftMode === "orgii_managed";
  const canApplyManaged = managedActive && Boolean(selectedKeyId);
  const isBusy = pendingAction !== null;
  const modeLabel =
    status?.mode === "orgii_managed"
      ? tr("agentOrgs.cliManagedConfig.modeOrgii", "ORGII Managed")
      : tr("agentOrgs.cliManagedConfig.modeDefault", "Default");

  return (
    <SectionContainer
      title={tr("agentOrgs.cliManagedConfig.title", "CLI config mode")}
    >
      <SectionRow
        label={tr("agentOrgs.cliManagedConfig.modeLabel", "Mode")}
        description={tr(
          "agentOrgs.cliManagedConfig.modeDesc",
          "Default keeps the original Codex config. ORGII Managed points Codex at the local ORGII proxy."
        )}
      >
        <div style={SECTION_CONTROL_STYLE}>
          <TabPill
            tabs={[
              {
                key: "default",
                label: tr("agentOrgs.cliManagedConfig.modeDefault", "Default"),
              },
              {
                key: "orgii_managed",
                label: tr(
                  "agentOrgs.cliManagedConfig.modeOrgii",
                  "ORGII Managed"
                ),
              },
            ]}
            activeTab={draftMode}
            onChange={handleModeChange}
            variant="pill"
            colorScheme="layout"
            fillWidth
            size="small"
          />
        </div>
      </SectionRow>

      <SectionRow label={tr("agentOrgs.cliManagedConfig.status", "Status")}>
        <StatusDot
          color={
            status?.conflict
              ? "bg-warning-6"
              : status?.mode === "orgii_managed"
                ? "bg-primary-6"
                : "bg-fill-3"
          }
          size="inline"
          labelClassName="text-sm text-text-1"
          label={
            status?.conflict
              ? tr("agentOrgs.cliManagedConfig.conflict", "External change")
              : modeLabel
          }
        />
      </SectionRow>

      {status?.conflict && (
        <SectionRow
          label={tr("agentOrgs.cliManagedConfig.conflictTitle", "Conflict")}
          description={tr(
            "agentOrgs.cliManagedConfig.conflictDesc",
            "The active Codex config changed after ORGII wrote it."
          )}
          align="start"
        >
          <AlertTriangle size={16} className="shrink-0 text-warning-6" />
        </SectionRow>
      )}

      <SectionRow
        label={tr("agentOrgs.cliManagedConfig.keyLabel", "Key")}
        description={tr(
          "agentOrgs.cliManagedConfig.keyDesc",
          "Stored in ORGII and referenced by the local proxy."
        )}
      >
        <Select
          value={selectedKeyId}
          options={accountOptions}
          onChange={handleAccountChange}
          placeholder={tr("agentOrgs.cliManagedConfig.selectKey", "Select key")}
          disabled={!managedActive || credentials.length === 0 || isBusy}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      <SectionRow label={tr("agentOrgs.cliManagedConfig.modelLabel", "Model")}>
        <Select
          value={selectedModel}
          options={modelOptions}
          onChange={(value) => setSelectedModel(String(value))}
          placeholder={tr(
            "agentOrgs.cliManagedConfig.selectModel",
            "Select model"
          )}
          disabled={!managedActive || modelOptions.length === 0 || isBusy}
          showSearch
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      <SectionRow
        label={tr("agentOrgs.cliManagedConfig.proxyUrl", "Proxy URL")}
      >
        <Input
          value={proxyUrl}
          onChange={(value: string) => setProxyUrl(value)}
          disabled={!managedActive || isBusy}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      {targetFile && (
        <SectionRow
          label={tr("agentOrgs.cliManagedConfig.configFile", "Config file")}
        >
          <span
            className={SECTION_PATH_TEXT_CLASSES}
            title={targetFile.targetPath}
          >
            {targetFile.targetPath}
          </span>
        </SectionRow>
      )}

      <SectionRow label={tr("agentOrgs.cliManagedConfig.actions", "Actions")}>
        <div className={SECTION_ACTION_GAP_CLASSES}>
          {credentials.length === 0 ? (
            <Button size="small" onClick={onOpenCredentials}>
              {tr("agentOrgs.cliManagedConfig.addKey", "Add key")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="small"
              icon={<Save size={14} />}
              disabled={!canApplyManaged || isBusy}
              loading={pendingAction === "apply"}
              onClick={() => void applyManaged(false)}
            >
              {tr("agentOrgs.cliManagedConfig.apply", "Apply")}
            </Button>
          )}
          <Button
            size="small"
            icon={<RotateCcw size={14} />}
            disabled={isBusy}
            loading={pendingAction === "restore"}
            onClick={() => void restoreDefault(false)}
          >
            {tr("agentOrgs.cliManagedConfig.restore", "Restore Default")}
          </Button>
          {status?.conflict && managedActive && (
            <Button
              variant="warning"
              size="small"
              icon={<ShieldCheck size={14} />}
              disabled={!canApplyManaged || isBusy}
              loading={pendingAction === "forceApply"}
              onClick={() => void applyManaged(true)}
            >
              {tr("agentOrgs.cliManagedConfig.forceApply", "Force Apply")}
            </Button>
          )}
          {status?.conflict && (
            <Button
              variant="warning"
              size="small"
              icon={<ShieldCheck size={14} />}
              disabled={isBusy}
              loading={pendingAction === "forceRestore"}
              onClick={() => void restoreDefault(true)}
            >
              {tr("agentOrgs.cliManagedConfig.forceRestore", "Force Restore")}
            </Button>
          )}
        </div>
      </SectionRow>
    </SectionContainer>
  );
};

export default CliManagedConfigSection;
