import { AlertTriangle, RotateCcw, Save, ShieldCheck } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type {
  CliConfigManagedStatus,
  CliManagedProxyStatus,
} from "@src/api/tauri/rpc/schemas/agentOrgs";
import { formatAgentType } from "@src/assets/providers";
import Button from "@src/components/Button";
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
import { startVisibilityAwarePoller } from "@src/shared/scheduling/visibilityAwarePoller";

import type { AvailableCliAgent } from "../types";
import {
  getManagedProxyAccounts,
  getManagedProxyDraftSelection,
  modelIdsFor,
} from "./cliManagedConfigUtils";

type CliConfigMode = "default" | "orgii_managed";
type PendingAction = "apply" | "forceApply" | "restore" | "forceRestore";

const DEFAULT_PROXY_URL = "http://127.0.0.1:17888";

function accountLabel(account: KeyVaultAccount): string {
  const name = account.name || account.apiKeyPreview || account.authMethod;
  return `${name} - ${formatAgentType(account.modelType)}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface CliConfigSwitchCardProps {
  agent: AvailableCliAgent;
  credentials: KeyVaultAccount[];
  onOpenCredentials: () => void;
}

const CliConfigSwitchCard: React.FC<CliConfigSwitchCardProps> = ({
  agent,
  credentials,
  onOpenCredentials,
}) => {
  const { t } = useTranslation("integrations");
  const [status, setStatus] = useState<CliConfigManagedStatus | null>(null);
  const [proxyStatus, setProxyStatus] = useState<CliManagedProxyStatus | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [draftMode, setDraftMode] = useState<CliConfigMode>("default");
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );

  const tr = useCallback(
    (key: string, defaultValue: string) => t(key, { defaultValue }),
    [t]
  );

  const candidateProxyCredentials = useMemo(
    () => getManagedProxyAccounts(credentials),
    [credentials]
  );

  const proxyCredentials = useMemo(() => {
    return getManagedProxyAccounts(
      candidateProxyCredentials,
      proxyStatus?.compatibleKeyIds
    );
  }, [candidateProxyCredentials, proxyStatus?.compatibleKeyIds]);

  const selectedAccount = useMemo(
    () => proxyCredentials.find((account) => account.id === selectedKeyId),
    [proxyCredentials, selectedKeyId]
  );

  const accountOptions = useMemo(
    () =>
      proxyCredentials.map((account) => ({
        label: accountLabel(account),
        value: account.id,
      })),
    [proxyCredentials]
  );

  const modelIds = useMemo(
    () => modelIdsFor(selectedAccount),
    [selectedAccount]
  );

  const modelOptions = useMemo(() => {
    return modelIds.map((model) => ({ label: model, value: model }));
  }, [modelIds]);

  const loadProxyStatus = useCallback(async () => {
    try {
      const nextProxyStatus = await rpc.agentOrgs.managedConfig.proxyStatus({
        agentName: agent.name,
      });
      setProxyStatus(nextProxyStatus);
    } catch (err) {
      setProxyStatus({
        agentName: agent.name,
        supported: true,
        running: false,
        ready: false,
        url: DEFAULT_PROXY_URL,
        compatibleKeyIds: [],
        message: errMessage(err),
      });
    }
  }, [agent.name]);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextProxyStatus] = await Promise.all([
        rpc.agentOrgs.managedConfig.getStatus({
          agentName: agent.name,
        }),
        rpc.agentOrgs.managedConfig.proxyStatus({
          agentName: agent.name,
        }),
      ]);
      setStatus(nextStatus);
      setProxyStatus(nextProxyStatus);
      setDraftMode(nextStatus.mode);
      const nextProxyCredentials = getManagedProxyAccounts(
        candidateProxyCredentials,
        nextProxyStatus.compatibleKeyIds
      );
      const nextSelection = getManagedProxyDraftSelection(
        nextProxyCredentials,
        nextStatus.selectedKeyId,
        nextStatus.selectedModel
      );
      setSelectedKeyId(nextSelection.keyId);
      setSelectedModel(nextSelection.model);
    } catch (err) {
      Message.error({
        content: errMessage(err),
        duration: 3000,
      });
    } finally {
      setLoading(false);
    }
  }, [agent.name, candidateProxyCredentials]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (proxyStatus?.running !== false) return;
    return startVisibilityAwarePoller(document, loadProxyStatus, 3000);
  }, [loadProxyStatus, proxyStatus?.running]);

  useEffect(() => {
    const nextSelection = getManagedProxyDraftSelection(
      proxyCredentials,
      selectedKeyId,
      selectedModel
    );
    if (nextSelection.keyId !== selectedKeyId) {
      setSelectedKeyId(nextSelection.keyId);
    }
    if (nextSelection.model !== selectedModel) {
      setSelectedModel(nextSelection.model);
    }
  }, [proxyCredentials, selectedKeyId, selectedModel]);

  const applyManaged = useCallback(
    async (force: boolean) => {
      setPendingAction(force ? "forceApply" : "apply");
      try {
        const nextStatus = await rpc.agentOrgs.managedConfig.enableOrgiiManaged(
          {
            agentName: agent.name,
            keyId: selectedKeyId || null,
            model: selectedModel || null,
            force,
          }
        );
        setStatus(nextStatus);
        setDraftMode(nextStatus.mode);
        await loadProxyStatus();
        Message.success({
          content: tr(
            "agentOrgs.cliManagedConfig.applySuccess",
            "ORGII managed config applied"
          ),
        });
      } catch (err) {
        setDraftMode(status?.mode ?? "default");
        Message.error({
          content: errMessage(err),
          duration: 3000,
        });
      } finally {
        setPendingAction(null);
      }
    },
    [
      agent.name,
      loadProxyStatus,
      selectedKeyId,
      selectedModel,
      status?.mode,
      tr,
    ]
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
        await loadProxyStatus();
        Message.success({
          content: tr(
            "agentOrgs.cliManagedConfig.restoreSuccess",
            "Default config restored"
          ),
        });
      } catch (err) {
        setDraftMode(status?.mode ?? "default");
        Message.error({
          content: errMessage(err),
          duration: 3000,
        });
      } finally {
        setPendingAction(null);
      }
    },
    [agent.name, loadProxyStatus, status?.mode, tr]
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
      const nextSelection = getManagedProxyDraftSelection(
        proxyCredentials,
        nextKeyId
      );
      setSelectedKeyId(nextSelection.keyId);
      setSelectedModel(nextSelection.model);
    },
    [proxyCredentials]
  );

  if (loading || !status?.supported || proxyStatus?.supported === false) {
    return null;
  }

  const targetFiles = status?.targetFiles ?? [];
  const managedActive = draftMode === "orgii_managed";
  const canApplyManaged =
    managedActive &&
    Boolean(selectedKeyId) &&
    Boolean(selectedModel) &&
    proxyStatus?.running === true;
  const isBusy = pendingAction !== null;
  const modeLabel =
    status?.mode === "orgii_managed"
      ? tr("agentOrgs.cliManagedConfig.modeOrgii", "ORGII Managed")
      : tr("agentOrgs.cliManagedConfig.modeDefault", "Default");
  const statusLabel = status?.conflict
    ? tr("agentOrgs.cliManagedConfig.conflict", "External change")
    : modeLabel;
  const statusColor = status?.conflict
    ? "bg-warning-6"
    : status?.mode === "orgii_managed"
      ? "bg-primary-6"
      : "bg-fill-3";
  const proxyReady =
    proxyStatus?.running === true &&
    (status?.mode !== "orgii_managed" || proxyStatus.ready === true);
  const proxyLabel = !managedActive
    ? tr("agentOrgs.cliManagedConfig.proxyDefault", "Default mode")
    : proxyReady
      ? tr("agentOrgs.cliManagedConfig.proxyReady", "Proxy ready")
      : tr("agentOrgs.cliManagedConfig.proxyNotReady", "Proxy not ready");
  const proxyColor = !managedActive
    ? "bg-fill-3"
    : proxyReady
      ? "bg-success-6"
      : "bg-warning-6";
  const proxyDescription =
    !proxyReady && proxyStatus?.message
      ? proxyStatus.message
      : tr(
          "agentOrgs.cliManagedConfig.proxyLifecycleDesc",
          "Keep ORGII running while using this mode. Closing the window keeps the proxy in the tray; quitting ORGII safely restores Default unless the config changed externally."
        );

  return (
    <SectionContainer
      titleSlot={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-text-2">
            {tr("agentOrgs.cliManagedConfig.title", "CLI config switch")}
          </span>
          <StatusDot
            color={statusColor}
            size="inline"
            labelClassName="text-[13px] text-text-2"
            label={statusLabel}
          />
        </div>
      }
    >
      <SectionRow
        label={tr("agentOrgs.cliManagedConfig.modeLabel", "Mode")}
        description={tr(
          "agentOrgs.cliManagedConfig.modeDesc",
          "Default restores the CLI's own config. ORGII Managed writes a backed-up proxy config."
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

      {status?.conflict && (
        <SectionRow
          label={tr("agentOrgs.cliManagedConfig.conflictTitle", "Conflict")}
          description={tr(
            "agentOrgs.cliManagedConfig.conflictDesc",
            "The active CLI config changed after ORGII wrote it."
          )}
          align="start"
        >
          <AlertTriangle size={16} className="shrink-0 text-warning-6" />
        </SectionRow>
      )}

      {managedActive && (
        <SectionRow
          label={tr("agentOrgs.cliManagedConfig.proxyStatus", "Proxy")}
          description={proxyDescription}
        >
          <StatusDot
            color={proxyColor}
            size="inline"
            labelClassName="text-sm text-text-1"
            label={proxyLabel}
          />
        </SectionRow>
      )}

      <SectionRow
        label={tr("agentOrgs.cliManagedConfig.keyLabel", "Key")}
        description={tr(
          "agentOrgs.cliManagedConfig.keyDesc",
          "Compatible API keys are filtered by the KeyVault registry."
        )}
      >
        <Select
          value={selectedKeyId}
          options={accountOptions}
          onChange={handleAccountChange}
          placeholder={tr("agentOrgs.cliManagedConfig.selectKey", "Select key")}
          disabled={!managedActive || proxyCredentials.length === 0 || isBusy}
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

      {targetFiles.length > 0 && (
        <SectionRow
          label={tr("agentOrgs.cliManagedConfig.configFile", "Config files")}
        >
          <div className="flex min-w-0 flex-col gap-1">
            {targetFiles.map((targetFile) => (
              <span
                key={targetFile.id}
                className={SECTION_PATH_TEXT_CLASSES}
                title={targetFile.targetPath}
              >
                {targetFile.targetPath}
              </span>
            ))}
          </div>
        </SectionRow>
      )}

      <SectionRow label={tr("agentOrgs.cliManagedConfig.actions", "Actions")}>
        <div className={SECTION_ACTION_GAP_CLASSES}>
          {proxyCredentials.length === 0 ? (
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

export default CliConfigSwitchCard;
