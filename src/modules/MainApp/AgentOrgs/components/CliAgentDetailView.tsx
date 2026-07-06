import { BookOpen, ExternalLink, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { autoDetectKey } from "@src/api/services/keyValidation";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import {
  type ModelType,
  formatAgentType,
  isApiKeyProvider,
} from "@src/assets/providers";
import Button from "@src/components/Button";
import DragTable, { type DragTableColumn } from "@src/components/DragTable";
import Message from "@src/components/Message";
import ModelIcon from "@src/components/ModelIcon";
import StatusDot from "@src/components/StatusDot";
import TabPill from "@src/components/TabPill";
import { buildIntegrationsPath } from "@src/config/mainAppPaths";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  getCliCompatibleAccounts,
  getCliCompatibleProviderTypes,
  useAgentCompatibility,
} from "@src/hooks/models/useAgentCompatibility";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  PANEL_HEADER_TOKENS,
} from "@src/modules/shared/layouts/blocks";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import type { AvailableCliAgent } from "../types";
import AgentDetailHeader from "./AgentDetailHeader";
import ClaudeCodeConfigSection from "./ClaudeCodeConfigSection";
import CliManagedConfigSection from "./CliManagedConfigSection";
import CliRawConfigFileEditor from "./CliRawConfigFileEditor";
import CodexConfigSection from "./CodexConfigSection";
import CursorCliConfigSection from "./CursorCliConfigSection";

type StructuredCliConfigSurface = "cursor" | "claudeCode" | "codex";
type CliAgentDetailTab = "core" | "config";
type CliAgentConfigViewMode = "ui" | "raw";

interface CliAgentDetailState {
  activeTab: CliAgentDetailTab;
  viewMode: CliAgentConfigViewMode;
  activeConfigFileId: string | null;
}

const cliAgentDetailState: CliAgentDetailState = {
  activeTab: "core",
  viewMode: "raw",
  activeConfigFileId: null,
};

function getStructuredCliConfigSurface(
  agentName: string
): StructuredCliConfigSurface | null {
  switch (agentName) {
    case CLI_AGENT.CURSOR:
      return "cursor";
    case CLI_AGENT.CLAUDE_CODE:
      return "claudeCode";
    case CLI_AGENT.CODEX:
      return "codex";
    default:
      return null;
  }
}

// ── Compatibility indicator ──

const SupportIndicator: React.FC<{
  supported: boolean;
  t: (key: string) => string;
}> = ({ supported, t }) => (
  <StatusDot
    color={supported ? "bg-success-6" : "bg-danger-6"}
    size="inline"
    labelClassName="text-sm text-text-1"
    label={
      supported
        ? t("agentOrgs.cliAgentDetail.supported")
        : t("agentOrgs.cliAgentDetail.notSupported")
    }
  />
);

// ── Main component ──

interface CliAgentDetailViewProps {
  agent: AvailableCliAgent;
  accounts: KeyVaultAccount[];
  onRefresh: () => Promise<void>;
}

const CliAgentDetailView: React.FC<CliAgentDetailViewProps> = ({
  agent,
  accounts,
  onRefresh,
}) => {
  const { t } = useTranslation("integrations");
  const { registry } = useAgentCompatibility();
  const { navigateToMainApp } = useAppNavigation();
  const agentType = agent.name as ModelType;
  const docsUrl = agent.docsUrl;

  const [detecting, setDetecting] = useState(false);
  const [activeTab, setActiveTabState] = useState<CliAgentDetailTab>(
    cliAgentDetailState.activeTab
  );
  const [viewMode, setViewModeState] = useState<CliAgentConfigViewMode>(
    cliAgentDetailState.viewMode
  );
  const [activeConfigFileId, setActiveConfigFileIdState] = useState<
    string | null
  >(cliAgentDetailState.activeConfigFileId);

  const structuredConfigSurface = getStructuredCliConfigSurface(agent.name);
  const hasStructuredConfig = structuredConfigSurface !== null;
  const selectedConfigFile =
    agent.configFiles.find((file) => file.id === activeConfigFileId) ??
    agent.configFiles[0] ??
    null;
  const hasConfig = agent.configFiles.length > 0;

  const setActiveTab = useCallback((nextActiveTab: string) => {
    const normalizedTab: CliAgentDetailTab =
      nextActiveTab === "config" ? "config" : "core";
    cliAgentDetailState.activeTab = normalizedTab;
    setActiveTabState(normalizedTab);
  }, []);

  const setViewMode = useCallback((nextViewMode: CliAgentConfigViewMode) => {
    cliAgentDetailState.viewMode = nextViewMode;
    setViewModeState(nextViewMode);
  }, []);

  const setActiveConfigFileId = useCallback((nextFileId: string | null) => {
    cliAgentDetailState.activeConfigFileId = nextFileId;
    setActiveConfigFileIdState(nextFileId);
  }, []);

  useEffect(() => {
    if (activeTab === "config" && !hasConfig) {
      cliAgentDetailState.activeTab = "core";
      setActiveTabState("core");
    }

    if (viewMode === "ui" && !hasStructuredConfig) {
      cliAgentDetailState.viewMode = "raw";
      setViewModeState("raw");
    }

    if (!hasConfig) {
      cliAgentDetailState.activeConfigFileId = null;
      setActiveConfigFileIdState(null);
      return;
    }

    const hasSelectedFile = agent.configFiles.some(
      (file) => file.id === activeConfigFileId
    );
    if (!hasSelectedFile) {
      const fallbackFileId = agent.configFiles[0]?.id ?? null;
      cliAgentDetailState.activeConfigFileId = fallbackFileId;
      setActiveConfigFileIdState(fallbackFileId);
    }
  }, [
    activeConfigFileId,
    activeTab,
    agent.configFiles,
    hasConfig,
    hasStructuredConfig,
    viewMode,
  ]);

  const tabs = useMemo(() => {
    const items = [
      { key: "core", label: t("agentOrgs.cliAgentDetail.tabCore") },
    ];
    if (hasConfig) {
      items.push({
        key: "config",
        label: t("agentOrgs.cliAgentDetail.tabConfig"),
      });
    }
    return items;
  }, [t, hasConfig]);

  const compatibleTypes = useMemo(
    () => getCliCompatibleProviderTypes(registry, agent.name),
    [registry, agent.name]
  );

  const credentials = useMemo(
    () => accounts.filter((acc) => compatibleTypes.has(acc.modelType)),
    [accounts, compatibleTypes]
  );

  const hasCompatibleAccounts = useMemo(
    () =>
      agent.hasKeys ||
      (agentType != null &&
        getCliCompatibleAccounts(registry, agentType, accounts).length > 0),
    [agent.hasKeys, agentType, registry, accounts]
  );

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    try {
      await autoDetectKey(agent.name as ModelType);
      await onRefresh();
      Message.success({
        content: t("agentOrgs.cliAgentDetail.detectSuccess"),
      });
    } catch (err) {
      Message.error({
        content: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDetecting(false);
    }
  }, [agent.name, onRefresh, t]);

  const handleOpenDocs = useCallback(() => {
    if (docsUrl) openExternalLink(docsUrl);
  }, [docsUrl]);

  const openCredentialInIntegrations = useCallback(() => {
    const path = buildIntegrationsPath({ category: "models" });
    navigateToMainApp(`${path}?modelsTab=my-accounts`, {
      title: "Agents",
      icon: "infinity",
    });
  }, [navigateToMainApp]);

  const credentialColumns = useMemo<DragTableColumn<KeyVaultAccount>[]>(
    () => [
      {
        key: "provider",
        label: t("agentOrgs.cliAgentDetail.keyProvider"),
        width: 140,
        renderCell: (row) => {
          const isApi = isApiKeyProvider(row.modelType);
          return (
            <span className="inline-flex items-center gap-2 text-[13px] text-text-2">
              {isApi ? (
                <ModelIcon agentType={row.modelType} size="small" />
              ) : (
                <ModelIcon agentType={row.modelType} size={16} />
              )}
              {formatAgentType(row.modelType)}
            </span>
          );
        },
      },
      {
        key: "name",
        label: t("agentOrgs.agentWizard.nameLabel"),
        renderCell: (row) => (
          <span className="truncate text-[13px] font-bold text-text-1">
            {row.name || row.apiKeyPreview || row.authMethod}
          </span>
        ),
      },
      {
        key: "category",
        label: t("agentOrgs.cliAgentDetail.keyType"),
        width: 100,
        renderCell: (row) => (
          <span className="text-[13px] text-text-3">
            {isApiKeyProvider(row.modelType)
              ? t("agentOrgs.cliAgentDetail.typeApiKey")
              : t("agentOrgs.cliAgentDetail.typePlan")}
          </span>
        ),
      },
      {
        key: "added",
        label: t("agentOrgs.cliAgentDetail.addedTime"),
        width: 120,
        renderCell: (row) => (
          <span className="whitespace-nowrap text-[13px] text-text-3">
            {row.connectedAt
              ? row.connectedAt.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              : "—"}
          </span>
        ),
      },
      {
        key: "actions",
        width: 40,
        renderCell: (_row) => (
          <Button
            variant="tertiary"
            icon={<ExternalLink size={14} />}
            iconOnly
            onClick={openCredentialInIntegrations}
            title={t("common:actions.open")}
          />
        ),
      },
    ],
    [t, openCredentialInIntegrations]
  );

  return (
    <DetailPanelContainer>
      <AgentDetailHeader
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        actions={
          <>
            {hasConfig &&
              activeTab === "config" &&
              viewMode === "raw" &&
              agent.configFiles.length > 1 && (
                <TabPill
                  tabs={agent.configFiles.map((file) => ({
                    key: file.id,
                    label: file.label,
                  }))}
                  activeTab={selectedConfigFile?.id ?? agent.configFiles[0].id}
                  onChange={setActiveConfigFileId}
                  variant="pill"
                  fillWidth={false}
                  size="small"
                />
              )}
            {hasConfig && activeTab === "config" && hasStructuredConfig && (
              <TabPill
                tabs={[
                  { key: "ui", label: "UI" },
                  { key: "raw", label: "Raw" },
                ]}
                activeTab={viewMode}
                onChange={(key) => setViewMode(key === "ui" ? "ui" : "raw")}
                variant="pill"
                fillWidth={false}
                size="small"
              />
            )}
            <Button
              {...PANEL_HEADER_TOKENS.actionButton}
              icon={
                <RefreshCw
                  size={PANEL_HEADER_TOKENS.buttonIconSize}
                  strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                  className={detecting ? "animate-spin" : ""}
                />
              }
              onClick={handleDetect}
              disabled={detecting}
              title={t("agentOrgs.cliAgentDetail.detectKeys")}
            />
            {docsUrl && (
              <Button
                {...PANEL_HEADER_TOKENS.actionButton}
                icon={
                  <BookOpen
                    size={PANEL_HEADER_TOKENS.buttonIconSize}
                    strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                  />
                }
                onClick={handleOpenDocs}
                title={t("agentOrgs.cliAgentDetail.docs")}
              />
            )}
          </>
        }
      />

      {activeTab === "config" && viewMode === "raw" && selectedConfigFile ? (
        <CliRawConfigFileEditor
          agentName={agent.name}
          configFile={selectedConfigFile}
        />
      ) : (
        <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
          <div
            className={`${DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop} flex flex-col gap-3`}
          >
            {activeTab === "core" && (
              <>
                <SectionContainer>
                  <SectionRow label={t("agentOrgs.agentWizard.nameLabel")}>
                    <span className="text-sm text-text-1">
                      {agent.displayName}
                    </span>
                  </SectionRow>
                  <SectionRow
                    label={t("agentOrgs.cliAgentDetail.installStatus")}
                  >
                    <StatusDot
                      color={agent.installed ? "bg-success-6" : "bg-fill-3"}
                      size="inline"
                      labelClassName="text-sm text-text-1"
                      label={t(
                        agent.installed
                          ? "agentOrgs.cliAgentDetail.installed"
                          : "agentOrgs.cliAgentDetail.notInstalled"
                      )}
                    />
                  </SectionRow>
                  <SectionRow label={t("agentOrgs.cliAgentDetail.keyStatus")}>
                    <StatusDot
                      color={
                        hasCompatibleAccounts ? "bg-success-6" : "bg-fill-3"
                      }
                      size="inline"
                      labelClassName="text-sm text-text-1"
                      label={
                        hasCompatibleAccounts
                          ? t("agentOrgs.cliAgentDetail.keysConfigured")
                          : t("agentOrgs.cliAgentDetail.noKeys")
                      }
                    />
                  </SectionRow>
                </SectionContainer>

                {agent.name === CLI_AGENT.CODEX && (
                  <CliManagedConfigSection
                    agent={agent}
                    credentials={credentials}
                    onOpenCredentials={openCredentialInIntegrations}
                  />
                )}

                <SectionContainer title={t("agentOrgs.cliAgentDetail.keys")}>
                  {agent.hasSubscriptionPlan ? (
                    <SectionRow label={`${agent.displayName} Plan`}>
                      <SupportIndicator supported t={t} />
                    </SectionRow>
                  ) : (
                    <SectionRow label={t("agentOrgs.cliAgentDetail.cliPlan")}>
                      <StatusDot
                        color="bg-fill-3"
                        size="inline"
                        labelClassName="text-sm text-text-1"
                        label={t("agentOrgs.cliAgentDetail.noPlanAvailable")}
                      />
                    </SectionRow>
                  )}
                  <SectionRow
                    label={t("agentOrgs.cliAgentDetail.bringYourOwnKeys")}
                  >
                    <SupportIndicator
                      supported={agent.compatibleApiProviders.length > 0}
                      t={t}
                    />
                  </SectionRow>
                </SectionContainer>

                <SectionContainer>
                  <SectionRow
                    label={t("agentOrgs.cliAgentDetail.keys")}
                    description={t("agentOrgs.cliAgentDetail.keyStatus")}
                    layout="vertical"
                  >
                    {/* Credentials are surfaced read-only here; ordering
                        has no semantic meaning (the runtime picks the
                        first matching account) so there's nothing to
                        persist. The user manages keys from Integrations. */}
                    <DragTable
                      columns={credentialColumns}
                      rows={credentials}
                      onChange={() => {}}
                      readOnly
                      headerHeight="compact"
                      onAdd={openCredentialInIntegrations}
                      addLabel={t("agentOrgs.cliAgentDetail.addKey")}
                      emptyText={t("agentOrgs.cliAgentDetail.noKeys")}
                    />
                  </SectionRow>
                </SectionContainer>

                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    onClick={openCredentialInIntegrations}
                  >
                    {t("agentOrgs.cliAgentDetail.editKeys")}
                  </Button>
                  <Button onClick={handleDetect} disabled={detecting}>
                    {t("agentOrgs.cliAgentDetail.detectKeys")}
                  </Button>
                </div>
              </>
            )}

            {activeTab === "config" &&
              viewMode === "ui" &&
              structuredConfigSurface &&
              (structuredConfigSurface === "cursor" ? (
                <CursorCliConfigSection />
              ) : structuredConfigSurface === "claudeCode" ? (
                <ClaudeCodeConfigSection />
              ) : (
                <CodexConfigSection />
              ))}
          </div>
        </div>
      )}
    </DetailPanelContainer>
  );
};

export default CliAgentDetailView;
