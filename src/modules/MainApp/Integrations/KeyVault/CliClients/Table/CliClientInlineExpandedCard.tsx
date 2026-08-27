import { Plus, RefreshCw, SquareArrowOutUpRight } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import { useRefreshSpin } from "@src/hooks/ui";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import {
  InlineCardBody,
  InlineCardFooter,
  InlineCardShell,
  InlineCardTabs,
} from "../../shared/InlineCardPrimitives";
import { CliClientSection } from "../Preview/CliClientSection";
import { CliClientStatusContent } from "./CliClientStatusContent";
import { CliClientSubscriptionsContent } from "./CliClientSubscriptionsContent";
import {
  hasCliClientActions,
  resolveCliClientInlineTab,
} from "./cliClientInlineModel";
import {
  CLI_CLIENT_INLINE_TAB,
  type CliClientInlineExpandedCardProps,
} from "./cliClientInlineTypes";

export {
  CLI_CLIENT_INLINE_TAB,
  type CliClientInlineTab,
} from "./cliClientInlineTypes";

const CliClientInlineExpandedCard = ({
  agent,
  accounts,
  activeTab,
  onActiveTabChange,
  onRefresh,
  refreshing = false,
  onAdd,
  cliAgents,
}: CliClientInlineExpandedCardProps) => {
  const { t } = useTranslation("integrations");
  const handleRefresh = useCallback(() => void onRefresh?.(), [onRefresh]);
  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    handleRefresh,
    refreshing,
    `cli-client-${agent.name}`
  );
  const hasClientActions = hasCliClientActions(agent);
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
  const effectiveActiveTab = resolveCliClientInlineTab(activeTab, tabs);

  const content = (() => {
    switch (effectiveActiveTab) {
      case CLI_CLIENT_INLINE_TAB.SUBSCRIPTIONS:
        return (
          <CliClientSubscriptionsContent
            agent={agent}
            accounts={accounts}
            t={t}
          />
        );
      case CLI_CLIENT_INLINE_TAB.CLIENT:
        return hasClientActions ? (
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
              cliAgents
                ? () => cliAgents.handleUninstall(agent.name)
                : undefined
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
      case CLI_CLIENT_INLINE_TAB.STATUS:
      default:
        return <CliClientStatusContent agent={agent} t={t} />;
    }
  })();
  const showFooter =
    effectiveActiveTab !== CLI_CLIENT_INLINE_TAB.CLIENT &&
    Boolean(onRefresh || agent.docsUrl || onAdd);

  return (
    <InlineCardShell>
      <InlineCardTabs
        tabs={tabs}
        activeTab={effectiveActiveTab}
        onChange={onActiveTabChange}
      />
      <InlineCardBody>{content}</InlineCardBody>
      {showFooter && (
        <InlineCardFooter>
          {onRefresh && (
            <Button
              variant="secondary"
              size="small"
              icon={<RefreshCw size={14} className={spinClass} />}
              onClick={handleRefreshClick}
              disabled={refreshing}
            >
              {t("common:actions.rescan")}
            </Button>
          )}
          {agent.docsUrl && (
            <Button
              variant="secondary"
              size="small"
              icon={<SquareArrowOutUpRight size={14} />}
              iconPosition="right"
              onClick={() => openExternalLink(agent.docsUrl!)}
            >
              {t("cliPreview.docs")}
            </Button>
          )}
          {onAdd && (
            <Button
              variant="secondary"
              size="small"
              icon={<Plus size={14} />}
              onClick={onAdd}
            >
              {t("cliPreview.addKey")}
            </Button>
          )}
        </InlineCardFooter>
      )}
    </InlineCardShell>
  );
};

export default CliClientInlineExpandedCard;
