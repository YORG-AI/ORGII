import { ExternalLink, Plus, RefreshCw } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { formatAgentType } from "@src/assets/providers";
import Button from "@src/components/Button";
import StatusDot from "@src/components/StatusDot";
import {
  type AvailableAgent,
  METHOD_DISPLAY_LABELS,
} from "@src/config/cliAgents";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { useRefreshSpin } from "@src/hooks/ui";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import { AccountSourceBreadcrumb } from "../../Models/Table/AccountSourceBreadcrumb";
import {
  InlineCardBody,
  InlineCardColumnStack,
  InlineCardFooter,
  InlineCardShell,
  InlineCardSplit,
  InlineCardTabs,
} from "../../shared/InlineCardPrimitives";
import { CliClientSection } from "../Preview/CliClientSection";
import { CliLaunchProfileSection } from "../Preview/CliLaunchProfileSection";

export const CLI_CLIENT_INLINE_TAB = {
  STATUS: "status",
  SUBSCRIPTIONS: "subscriptions",
  CLIENT: "client",
} as const;

export type CliClientInlineTab =
  (typeof CLI_CLIENT_INLINE_TAB)[keyof typeof CLI_CLIENT_INLINE_TAB];

interface CliAgentsHandlers {
  actionMap: Record<string, "installing" | "detecting" | null>;
  handleInstall: (agentName: string, installCmd?: string) => Promise<void>;
  handleUninstall: (agentName: string, uninstallCmd?: string) => Promise<void>;
}

interface CliClientInlineExpandedCardProps {
  agent: AvailableAgent;
  accounts: KeyVaultAccount[];
  activeTab: CliClientInlineTab;
  onActiveTabChange: (tab: CliClientInlineTab) => void;
  onRefresh?: () => Promise<void>;
  refreshing?: boolean;
  onAdd?: () => void;
  cliAgents?: CliAgentsHandlers;
}

type AcpSupport = AvailableAgent["acpSupport"];

const ACP_SUPPORT_DOT_COLOR: Record<AcpSupport, string> = {
  native: "bg-success-6",
  adapter_backed: "bg-success-6",
  planned: "bg-warning-6",
  partial: "bg-warning-6",
  unavailable: "bg-text-4",
};

function StatusValue({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`text-[12px] font-medium ${active ? "text-success-6" : "text-text-3"}`}
    >
      {children}
    </span>
  );
}

const CliClientInlineExpandedCard: React.FC<
  CliClientInlineExpandedCardProps
> = ({
  agent,
  accounts,
  activeTab,
  onActiveTabChange,
  onRefresh,
  refreshing = false,
  onAdd,
  cliAgents,
}) => {
  const { t } = useTranslation("integrations");
  const handleRefresh = useCallback(() => {
    void onRefresh?.();
  }, [onRefresh]);
  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    handleRefresh,
    refreshing,
    `cli-client-${agent.name}`
  );

  const subscriptionAccounts = useMemo(
    () => accounts.filter((account) => account.modelType === agent.name),
    [accounts, agent.name]
  );
  const hasClientActions =
    (!agent.installed && agent.installMethods.length > 0) ||
    (agent.installed && agent.uninstallMethods.length > 0);
  const compatibleApiLabels = useMemo(
    () =>
      agent.compatibleApiProviders.map((provider) => formatAgentType(provider)),
    [agent.compatibleApiProviders]
  );
  const tabs = useMemo(
    () => [
      {
        key: CLI_CLIENT_INLINE_TAB.STATUS,
        label: t("keyVault.inlineCard.tabStatus"),
      },
      {
        key: CLI_CLIENT_INLINE_TAB.SUBSCRIPTIONS,
        label: t("cliPreview.subscriptions"),
      },
      {
        key: CLI_CLIENT_INLINE_TAB.CLIENT,
        label: t("cliPreview.clientSection"),
        disabled: !hasClientActions,
      },
    ],
    [hasClientActions, t]
  );

  const effectiveActiveTab = useMemo(() => {
    const match = tabs.find((tab) => tab.key === activeTab && !tab.disabled);
    return match?.key ?? CLI_CLIENT_INLINE_TAB.STATUS;
  }, [activeTab, tabs]);

  const subscriptionsContent = (
    <InlineCardColumnStack>
      {agent.nativeSubscriptionLabels.length > 0 ? (
        <InfoRow label={t("cliPreview.nativeSubscription")} layout="vertical">
          <InlineCardColumnStack gap="compact">
            {agent.nativeSubscriptionLabels.map((label) => (
              <span key={label} className="text-[12px] text-text-1">
                {label}
              </span>
            ))}
          </InlineCardColumnStack>
        </InfoRow>
      ) : null}
      <InfoRow label={t("cliPreview.compatibleApis")} layout="vertical">
        {compatibleApiLabels.length > 0 ? (
          <span className="text-[12px] text-text-1">
            {compatibleApiLabels.join(", ")}
          </span>
        ) : (
          <span className="text-[12px] text-text-3">
            {t("common:status.na")}
          </span>
        )}
      </InfoRow>
      <InfoRow label={t("cliPreview.supportedProtocols")} layout="vertical">
        {agent.supportedProtocols.length > 0 ? (
          <span className="text-[12px] text-text-1">
            {agent.supportedProtocols.join(", ")}
          </span>
        ) : (
          <span className="text-[12px] text-text-3">
            {t("common:status.na")}
          </span>
        )}
      </InfoRow>
      <InfoRow label={t("cliPreview.addedSubscriptions")} layout="vertical">
        {subscriptionAccounts.length > 0 ? (
          <InlineCardColumnStack gap="compact">
            {subscriptionAccounts.map((account) => (
              <div
                key={account.id}
                className="flex h-9 min-h-9 items-center justify-between gap-3 rounded-md px-3 text-xs hover:bg-fill-1"
              >
                <div className="flex min-w-0 flex-1 items-center">
                  <AccountSourceBreadcrumb
                    modelType={account.modelType}
                    accountName={account.name}
                  />
                </div>
              </div>
            ))}
          </InlineCardColumnStack>
        ) : (
          <span className="text-[12px] text-text-3">
            {t("cliPreview.noSubscriptions")}
          </span>
        )}
      </InfoRow>
    </InlineCardColumnStack>
  );

  const clientContent = hasClientActions ? (
    <CliClientSection
      agentName={agent.name}
      installMethods={agent.installMethods}
      uninstallMethods={agent.uninstallMethods}
      defaultMode={agent.installed ? "uninstall" : "install"}
      defaultMethodId={agent.installedVia}
      onInstall={
        cliAgents ? () => cliAgents.handleInstall(agent.name) : undefined
      }
      onUninstall={
        cliAgents ? () => cliAgents.handleUninstall(agent.name) : undefined
      }
      actionLoading={cliAgents?.actionMap[agent.name] === "installing"}
      actionDisabled={(cliAgents?.actionMap[agent.name] ?? null) !== null}
    />
  ) : (
    <Placeholder
      variant="empty"
      title={
        agent.installed
          ? t("cliPreview.noUninstallScript")
          : t("cliPreview.noInstallScript")
      }
    />
  );

  const tabContent = (() => {
    switch (effectiveActiveTab) {
      case CLI_CLIENT_INLINE_TAB.SUBSCRIPTIONS:
        return subscriptionsContent;
      case CLI_CLIENT_INLINE_TAB.CLIENT:
        return clientContent;
      case CLI_CLIENT_INLINE_TAB.STATUS:
      default:
        return (
          <InlineCardColumnStack>
            <CliLaunchProfileSection agentName={agent.name} />
            <div className="border-t border-border-2 pt-3" />
            <InlineCardSplit
              equalColumns
              left={
                <InlineCardColumnStack>
                  <InfoRow label={t("cliPreview.installed")}>
                    <StatusValue active={agent.installed}>
                      {agent.installed
                        ? t("common:status.yes")
                        : t("common:status.no")}
                    </StatusValue>
                  </InfoRow>
                  <InfoRow label={t("cliPreview.keys")}>
                    <StatusValue active={agent.hasKeys}>
                      {agent.hasKeys
                        ? t("cliPreview.configured")
                        : t("cliPreview.notConfigured")}
                    </StatusValue>
                  </InfoRow>
                  {agent.installed ? (
                    <InfoRow label={t("cliPreview.installedVia")}>
                      <span
                        className={`text-[12px] font-medium ${agent.installedVia ? "text-text-1" : "text-text-3"}`}
                      >
                        {agent.installedVia
                          ? (METHOD_DISPLAY_LABELS[agent.installedVia] ??
                            agent.installedVia)
                          : t("common:status.na")}
                      </span>
                    </InfoRow>
                  ) : null}
                </InlineCardColumnStack>
              }
              right={
                <InlineCardColumnStack>
                  <InfoRow label={t("cliPreview.acpSupport")}>
                    <StatusDot
                      color={ACP_SUPPORT_DOT_COLOR[agent.acpSupport]}
                      size="inline"
                      label={t(
                        `cliPreview.acpSupportLabels.${agent.acpSupport}`
                      )}
                    />
                  </InfoRow>
                </InlineCardColumnStack>
              }
            />
          </InlineCardColumnStack>
        );
    }
  })();

  return (
    <InlineCardShell>
      <InlineCardTabs
        tabs={tabs}
        activeTab={effectiveActiveTab}
        onChange={onActiveTabChange}
      />
      <InlineCardBody>{tabContent}</InlineCardBody>
      {effectiveActiveTab !== CLI_CLIENT_INLINE_TAB.CLIENT &&
      (onRefresh || agent.docsUrl || onAdd) ? (
        <InlineCardFooter>
          {onRefresh ? (
            <Button
              variant="secondary"
              size="small"
              icon={<RefreshCw size={14} className={spinClass} />}
              onClick={handleRefreshClick}
              disabled={refreshing}
            >
              {t("common:actions.rescan")}
            </Button>
          ) : null}
          {agent.docsUrl ? (
            <Button
              variant="secondary"
              size="small"
              icon={<ExternalLink size={14} />}
              iconPosition="right"
              onClick={() => openExternalLink(agent.docsUrl!)}
            >
              {t("cliPreview.docs")}
            </Button>
          ) : null}
          {onAdd ? (
            <Button
              variant="secondary"
              size="small"
              icon={<Plus size={14} />}
              onClick={onAdd}
            >
              {t("cliPreview.addKey")}
            </Button>
          ) : null}
        </InlineCardFooter>
      ) : null}
    </InlineCardShell>
  );
};

export default CliClientInlineExpandedCard;
