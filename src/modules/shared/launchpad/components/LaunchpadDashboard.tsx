import { useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { RUST_AGENT_TYPE } from "@src/api/tauri/agent/types";
import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import { ROUTES } from "@src/config/routes";
import { useKeyVault } from "@src/hooks/keyVault";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { AccountStatusIndicator } from "@src/modules/shared/keyVault/AccountStatusIndicator";
import {
  InlineInfoCard,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import { openOrFocusChatPanelStartPageTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type { Repo } from "@src/store/repo/types";
import {
  SESSION_TARGET_KIND,
  sessionCreatorStateAtom,
} from "@src/store/session";
import type { AgentConfigTabVariant } from "@src/store/workstation/tabs";
import { getRustAgentType } from "@src/util/session/sessionDispatch";
import { openAgentConfigInWorkStation } from "@src/util/ui/openAgentConfigInWorkStation";

import { useContainerEngines } from "../hooks/useContainerEngines";
import { useContainers } from "../hooks/useContainers";
import {
  rustBuiltInVariantsFromDefinitions,
  useLaunchpadAgentCatalog,
} from "../hooks/useLaunchpadAgentCatalog";
import ContainerEnginesSection from "./ContainerEnginesSection";
import ContainersSection from "./ContainersSection";
import LaunchpadActionStrip from "./LaunchpadActionStrip";
import {
  type LaunchpadAgentAction,
  LaunchpadAgentActionStrip,
} from "./LaunchpadDashboardAgentActionStrip";
import {
  LaunchpadAddTile,
  LaunchpadCollapsibleSection,
  LaunchpadTile,
  LaunchpadTileWrap,
  LaunchpadWorkspaceCard,
} from "./LaunchpadDashboardTiles";

interface LaunchpadDashboardProps {
  repos: Repo[];
  loading: boolean;
  /** Currently highlighted workspace card (drives the action strip). */
  selectedDashboardRepoId: string | null;
  onSelectDashboardRepo: (repoId: string | null) => void;
  /**
   * Explicit "Open details" path — navigates to the workspace overview
   * surface for the repo and selects the Details tab.
   */
  onOpenRepoDetails: (repo: Repo) => void;
  onAddWorkspace: () => void;
}

const AccountInlineDetails = React.lazy(
  () => import("@src/modules/shared/keyVault/AccountInlineDetails")
);

const LaunchpadDashboard: React.FC<LaunchpadDashboardProps> = memo(
  ({
    repos,
    loading,
    selectedDashboardRepoId,
    onSelectDashboardRepo,
    onOpenRepoDetails,
    onAddWorkspace,
  }) => {
    const { t } = useTranslation(["navigation", "sessions"]);
    const { navigateTo } = useAppNavigation();
    const setCreatorState = useSetAtom(sessionCreatorStateAtom);
    // The dashboard now lives under Runtime → Assets. Launching an agent
    // focuses the singleton Launchpad so its session creator can consume the
    // creator state written below.
    const openStartPageTab = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
    const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(
      null
    );
    const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
      null
    );
    const [refreshingAccountId, setRefreshingAccountId] = useState<
      string | null
    >(null);
    const [accountsOpen, setAccountsOpen] = useState(false);
    const [agentsOpen, setAgentsOpen] = useState(false);
    const [containerEnginesOpen, setContainerEnginesOpen] = useState(false);
    const [containersOpen, setContainersOpen] = useState(false);

    const {
      installedCliAgents,
      builtInRustAgents,
      customRustAgents,
      ready: catalogReady,
    } = useLaunchpadAgentCatalog(agentsOpen);

    const {
      localAccounts,
      loading: keysLoading,
      refreshAccount,
    } = useKeyVault({ autoLoad: accountsOpen });

    const {
      containers,
      loading: containersLoading,
      error: containersError,
      refresh: refreshContainers,
    } = useContainers(containersOpen);
    const {
      remoteEngines,
      loading: enginesLoading,
      error: enginesError,
      refresh: refreshEngines,
    } = useContainerEngines(containerEnginesOpen);

    const rankedAgents = useMemo<LaunchpadAgentAction[]>(() => {
      const cliRows = installedCliAgents
        .slice()
        .sort(
          (agentA, agentB) => Number(agentB.popular) - Number(agentA.popular)
        )
        .map((agent) => ({
          key: agent.name,
          label: agent.displayName,
          icon: <ModelIcon agentType={agent.name as CliAgentType} size={30} />,
          onLaunch: () => {
            setCreatorState((prev) => ({
              ...prev,
              dispatchCategory: "cli_agent",
              targetKind: SESSION_TARGET_KIND.CLI_AGENT,
              cliAgentType: agent.name as CliAgentType,
              selectedAgentDefinitionId: null,
              selectedAgentOrgId: null,
              agentName: agent.displayName,
              agentIconId: null,
            }));
            openStartPageTab({});
          },
          onOpenDetails: () => {
            openAgentConfigInWorkStation({
              variant: "cli",
              entityId: agent.name,
              displayName: agent.displayName,
              cliAgentType: agent.name,
            });
          },
        }));

      const rustBuiltInVariants =
        rustBuiltInVariantsFromDefinitions(builtInRustAgents);
      const rustRows = rustBuiltInVariants.map((rustType) => {
        const definition = builtInRustAgents.find(
          (definitionItem) => getRustAgentType(definitionItem.id) === rustType
        );
        const IconComponent = resolveAgentIcon(definition?.iconId);
        const label =
          definition?.name ??
          rustType ??
          t("sessions:controlTower.history.agentFallback");
        const variant: AgentConfigTabVariant =
          rustType === RUST_AGENT_TYPE.OS
            ? "builtin-os"
            : rustType === RUST_AGENT_TYPE.SDE
              ? "builtin-sde"
              : rustType === RUST_AGENT_TYPE.WINGMAN
                ? "wingman"
                : "custom";
        return {
          key: rustType,
          label,
          icon: React.createElement(IconComponent, {
            size: 30,
            strokeWidth: 1.75,
            className: "text-text-2",
          }),
          onLaunch: () => {
            setCreatorState((prev) => ({
              ...prev,
              dispatchCategory: "rust_agent",
              targetKind: SESSION_TARGET_KIND.AGENT,
              selectedAgentDefinitionId: definition?.id ?? null,
              selectedAgentOrgId: null,
              agentName: label,
              agentIconId: null,
              cliAgentType: null,
            }));
            openStartPageTab({});
          },
          onOpenDetails: () => {
            if (!definition) return;
            openAgentConfigInWorkStation({
              variant,
              entityId: definition.id,
              displayName: label,
            });
          },
        };
      });

      const customRows = customRustAgents.map((definition) => {
        const IconComponent = resolveAgentIcon(definition.iconId);
        return {
          key: definition.id,
          label: definition.name,
          icon: React.createElement(IconComponent, {
            size: 30,
            strokeWidth: 1.75,
            className: "text-text-2",
          }),
          onLaunch: () => {
            setCreatorState((prev) => ({
              ...prev,
              dispatchCategory: "rust_agent",
              targetKind: SESSION_TARGET_KIND.AGENT,
              selectedAgentDefinitionId: definition.id,
              selectedAgentOrgId: null,
              agentName: definition.name,
              agentIconId: null,
              cliAgentType: null,
            }));
            openStartPageTab({});
          },
          onOpenDetails: () => {
            openAgentConfigInWorkStation({
              variant: "custom",
              entityId: definition.id,
              displayName: definition.name,
            });
          },
        };
      });

      return [...rustRows, ...customRows, ...cliRows];
    }, [
      installedCliAgents,
      builtInRustAgents,
      customRustAgents,
      setCreatorState,
      openStartPageTab,
      t,
    ]);

    const handleSelectWorkspace = useCallback(
      (repo: Repo) => {
        if (repo.id === selectedDashboardRepoId) {
          onSelectDashboardRepo(null);
        } else {
          onSelectDashboardRepo(repo.id);
        }
      },
      [selectedDashboardRepoId, onSelectDashboardRepo]
    );

    const handleSelectAgent = useCallback((agent: LaunchpadAgentAction) => {
      setSelectedAgentKey((currentKey) =>
        currentKey === agent.key ? null : agent.key
      );
    }, []);

    const handleSelectAccount = useCallback(
      (accountId: string) => {
        if (selectedAccountId === accountId) {
          setSelectedAccountId(null);
          return;
        }
        setSelectedAccountId(accountId);
        setRefreshingAccountId(accountId);
        void refreshAccount(accountId, true)
          .catch(() => false)
          .finally(() => {
            setRefreshingAccountId((currentId) =>
              currentId === accountId ? null : currentId
            );
          });
      },
      [refreshAccount, selectedAccountId]
    );

    const handleAddKey = useCallback(() => {
      const accountsPath = `${buildIntegrationsPath({
        category: "models",
      })}?modelsTab=my-accounts`;
      navigateTo(buildWizardPath(accountsPath, WIZARD_IDS.KEY_ADD));
    }, [navigateTo]);

    const handleAddAgent = useCallback(() => {
      navigateTo(
        buildWizardPath(ROUTES.app.agentOrgs.path, WIZARD_IDS.AGENT_ADD)
      );
    }, [navigateTo]);

    const handleClearSelection = useCallback(
      () => onSelectDashboardRepo(null),
      [onSelectDashboardRepo]
    );
    const selectedDashboardRepo =
      repos.find((repo) => repo.id === selectedDashboardRepoId) ?? null;
    const selectedAgent =
      rankedAgents.find((agent) => agent.key === selectedAgentKey) ?? null;
    const selectedAccount =
      localAccounts.find((account) => account.id === selectedAccountId) ?? null;

    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          <div
            className={`flex flex-col gap-5 px-4 py-5 ${DETAIL_PANEL_TOKENS.headerWidth}`}
          >
            <div className="flex flex-col gap-2">
              <LaunchpadCollapsibleSection
                title={t("navigation:launchpad.myWorkspaces")}
              >
                {loading ? (
                  <Placeholder variant="loading" />
                ) : (
                  <LaunchpadTileWrap
                    actionAfterIndex={
                      selectedDashboardRepo
                        ? repos.indexOf(selectedDashboardRepo)
                        : -1
                    }
                    action={
                      selectedDashboardRepo ? (
                        <LaunchpadActionStrip
                          repo={selectedDashboardRepo}
                          onOpenDetails={onOpenRepoDetails}
                          onClear={handleClearSelection}
                        />
                      ) : null
                    }
                  >
                    {repos.map((repo) => (
                      <LaunchpadWorkspaceCard
                        key={repo.id}
                        repo={repo}
                        selected={repo.id === selectedDashboardRepoId}
                        onSelect={handleSelectWorkspace}
                      />
                    ))}
                    <LaunchpadAddTile
                      onCreate={onAddWorkspace}
                      label={t("navigation:launchpad.addWorkspace")}
                    />
                  </LaunchpadTileWrap>
                )}
              </LaunchpadCollapsibleSection>
            </div>

            <LaunchpadCollapsibleSection
              title={t("sessions:controlTower.myApiKeys", {
                count: localAccounts.length,
              })}
              defaultOpen={false}
              onOpenChange={setAccountsOpen}
            >
              {keysLoading ? (
                <Placeholder variant="loading" />
              ) : (
                <LaunchpadTileWrap
                  actionAfterIndex={
                    selectedAccount
                      ? localAccounts.indexOf(selectedAccount)
                      : -1
                  }
                  action={
                    selectedAccount ? (
                      <InlineInfoCard
                        contentClassName="bg-bg-2"
                        dataTestId="launchpad-key-inline-details"
                      >
                        <React.Suspense
                          fallback={<Placeholder variant="loading" />}
                        >
                          {refreshingAccountId === selectedAccount.id ? (
                            <Placeholder variant="loading" />
                          ) : (
                            <div className="flex min-w-0 flex-col gap-2">
                              <AccountInlineDetails account={selectedAccount} />
                              <div className="flex min-h-8 items-center border-t border-border-2 pt-2">
                                <AccountStatusIndicator
                                  account={selectedAccount}
                                />
                              </div>
                            </div>
                          )}
                        </React.Suspense>
                      </InlineInfoCard>
                    ) : null
                  }
                >
                  {localAccounts.map((account) => {
                    const isReady = account.status === "ready";
                    return (
                      <LaunchpadTile
                        key={account.id}
                        icon={
                          <ModelIcon
                            agentType={account.modelType}
                            size={30}
                            className="shrink-0 text-text-2"
                          />
                        }
                        label={account.name}
                        title={account.name}
                        selected={account.id === selectedAccountId}
                        onClick={() => handleSelectAccount(account.id)}
                        dataTestId={`launchpad-key-${account.id}`}
                        status={
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${isReady ? "bg-success-6" : "bg-text-4"}`}
                            title={account.status}
                          />
                        }
                      />
                    );
                  })}
                  <LaunchpadAddTile
                    onCreate={handleAddKey}
                    label={t("sessions:controlTower.addApiKey")}
                  />
                </LaunchpadTileWrap>
              )}
            </LaunchpadCollapsibleSection>

            <div className="flex flex-col gap-2">
              <LaunchpadCollapsibleSection
                title={t("sessions:controlTower.myAgents", {
                  count: rankedAgents.length,
                })}
                defaultOpen={false}
                onOpenChange={setAgentsOpen}
              >
                {!catalogReady ? (
                  <Placeholder variant="loading" />
                ) : rankedAgents.length === 0 ? (
                  <Placeholder
                    variant="empty"
                    title={t("sessions:controlTower.noAgentsAvailable")}
                  />
                ) : (
                  <LaunchpadTileWrap
                    actionAfterIndex={
                      selectedAgent ? rankedAgents.indexOf(selectedAgent) : -1
                    }
                    action={
                      selectedAgent ? (
                        <LaunchpadAgentActionStrip agent={selectedAgent} />
                      ) : null
                    }
                  >
                    {rankedAgents.map((agent) => (
                      <LaunchpadTile
                        key={agent.key}
                        icon={agent.icon}
                        label={agent.label}
                        title={t("sessions:controlTower.newAgentSession", {
                          agent: agent.label,
                        })}
                        selected={agent.key === selectedAgentKey}
                        onClick={() => handleSelectAgent(agent)}
                      />
                    ))}
                    <LaunchpadAddTile
                      onCreate={handleAddAgent}
                      label={t("sessions:controlTower.addAgent")}
                    />
                  </LaunchpadTileWrap>
                )}
              </LaunchpadCollapsibleSection>
            </div>

            <ContainerEnginesSection
              engines={remoteEngines}
              loading={enginesLoading}
              error={enginesError}
              onRefresh={refreshEngines}
              defaultOpen={false}
              onOpenChange={setContainerEnginesOpen}
              compact
            />

            <ContainersSection
              title={t("navigation:launchpad.containers.title")}
              containers={containers}
              loading={containersLoading}
              error={containersError}
              onRefresh={refreshContainers}
              emptyTitle={t("navigation:launchpad.containers.emptyTitle")}
              emptySubtitle={t("navigation:launchpad.containers.emptySubtitle")}
              defaultOpen={false}
              onOpenChange={setContainersOpen}
              compact
            />
          </div>
        </div>
      </div>
    );
  }
);
LaunchpadDashboard.displayName = "LaunchpadDashboard";

export default LaunchpadDashboard;
