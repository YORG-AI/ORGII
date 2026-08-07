import { useSetAtom } from "jotai";
import { Expand, Play, Plus } from "lucide-react";
import React, {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { RUST_AGENT_TYPE } from "@src/api/tauri/agent/types";
import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import Button from "@src/components/Button";
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
  CollapsibleSection,
  InlineInfoCard,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import type { Repo } from "@src/store/repo/types";
import {
  SESSION_TARGET_KIND,
  sessionCreatorStateAtom,
} from "@src/store/session";
import {
  CHAT_PANEL_START_PAGE_TAB,
  chatPanelStartPageTabAtom,
} from "@src/store/ui/chatPanelAtom";
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
import MacFolderIcon from "./MacFolderIcon";

interface LaunchpadDashboardProps {
  /** Optional content rendered first in the dashboard's shared scroll area. */
  headerContent?: React.ReactNode;
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

const LAUNCHPAD_TILE_CLASS =
  "group/launchpadtile flex w-20 shrink-0 flex-col items-center gap-1.5 border-none bg-transparent p-0 text-center outline-none";

const LAUNCHPAD_TILE_ICON_CLASS =
  "relative flex h-12 w-16 items-center justify-center rounded-lg transition-colors duration-150 group-hover/launchpadtile:bg-fill-2";

const LAUNCHPAD_TILE_ICON_SELECTED_CLASS =
  "relative flex h-12 w-16 items-center justify-center rounded-lg bg-fill-2 transition-colors duration-150";

const LAUNCHPAD_TILE_LABEL_CLASS =
  "line-clamp-2 w-20 text-center text-[12px] font-normal leading-tight text-text-2 transition-colors group-hover/launchpadtile:text-text-1";

const LAUNCHPAD_TILE_LABEL_SELECTED_CLASS =
  "line-clamp-2 w-20 text-center text-[12px] font-normal leading-tight text-text-1";

const AccountInlineDetails = React.lazy(
  () => import("@src/modules/shared/keyVault/AccountInlineDetails")
);

interface LaunchpadCollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
}

const LaunchpadCollapsibleSection: React.FC<LaunchpadCollapsibleSectionProps> =
  memo(({ title, children }) => (
    <CollapsibleSection title={title} compact chevronStrokeWidth={1.75}>
      {children}
    </CollapsibleSection>
  ));
LaunchpadCollapsibleSection.displayName = "LaunchpadCollapsibleSection";

const LaunchpadTileWrap: React.FC<{
  children: React.ReactNode;
  actionAfterIndex?: number;
  action?: React.ReactNode;
}> = ({ children, actionAfterIndex = -1, action }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);
  const items = React.Children.toArray(children);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateColumnCount = (): void => {
      const tileWidth = 80;
      const gap = 8;
      setColumnCount(
        Math.max(
          1,
          Math.floor((container.clientWidth + gap) / (tileWidth + gap))
        )
      );
    };

    updateColumnCount();
    const observer = new ResizeObserver(updateColumnCount);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const rowEndIndex =
    actionAfterIndex >= 0
      ? Math.min(
          items.length - 1,
          (Math.floor(actionAfterIndex / columnCount) + 1) * columnCount - 1
        )
      : -1;

  return (
    <div ref={containerRef} className="flex flex-wrap gap-2 pb-2">
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {item}
          {index === rowEndIndex && action ? (
            <div className="min-w-0 basis-full">{action}</div>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
};

interface LaunchpadTileProps {
  icon: React.ReactNode;
  label: string;
  title?: string;
  status?: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  dataTestId?: string;
}

const LaunchpadTile: React.FC<LaunchpadTileProps> = memo(
  ({ icon, label, title, status, selected = false, onClick, dataTestId }) => {
    const content = (
      <>
        <div
          className={
            selected
              ? LAUNCHPAD_TILE_ICON_SELECTED_CLASS
              : LAUNCHPAD_TILE_ICON_CLASS
          }
        >
          {icon}
          {status ? (
            <span className="absolute right-1.5 top-1.5">{status}</span>
          ) : null}
        </div>
        <span
          className={
            selected
              ? LAUNCHPAD_TILE_LABEL_SELECTED_CLASS
              : LAUNCHPAD_TILE_LABEL_CLASS
          }
        >
          {label}
        </span>
      </>
    );

    if (onClick) {
      return (
        <button
          type="button"
          onClick={onClick}
          className={LAUNCHPAD_TILE_CLASS}
          title={title ?? label}
          aria-pressed={selected}
          data-testid={dataTestId}
        >
          {content}
        </button>
      );
    }

    return (
      <div className={LAUNCHPAD_TILE_CLASS} title={title ?? label}>
        {content}
      </div>
    );
  }
);
LaunchpadTile.displayName = "LaunchpadTile";

interface LaunchpadAddTileProps {
  onCreate: () => void;
  label: string;
}

const LaunchpadAddTile: React.FC<LaunchpadAddTileProps> = memo(
  ({ onCreate, label }) => (
    <button
      type="button"
      onClick={onCreate}
      className={LAUNCHPAD_TILE_CLASS}
      title={label}
      aria-label={label}
    >
      <div className={LAUNCHPAD_TILE_ICON_CLASS}>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-1">
          <Plus size={18} strokeWidth={1.75} className="text-text-3" />
        </span>
      </div>
      <span className={LAUNCHPAD_TILE_LABEL_CLASS}>{label}</span>
    </button>
  )
);
LaunchpadAddTile.displayName = "LaunchpadAddTile";

interface LaunchpadWorkspaceCardProps {
  repo: Repo;
  selected: boolean;
  onSelect: (repo: Repo) => void;
}

const LaunchpadWorkspaceCard: React.FC<LaunchpadWorkspaceCardProps> = memo(
  ({ repo, selected, onSelect }) => {
    const label = repo.name || repo.path?.split("/").pop() || "Repo";
    const initial = label.charAt(0).toUpperCase();
    const handleClick = () => onSelect(repo);

    return (
      <button
        type="button"
        onClick={handleClick}
        className={LAUNCHPAD_TILE_CLASS}
        title={repo.path ?? label}
        aria-pressed={selected}
      >
        <div
          className={
            selected
              ? LAUNCHPAD_TILE_ICON_SELECTED_CLASS
              : LAUNCHPAD_TILE_ICON_CLASS
          }
        >
          <MacFolderIcon
            color="var(--color-primary-6)"
            label={initial}
            size={36}
            className="shrink-0"
          />
        </div>
        <span
          className={
            selected
              ? LAUNCHPAD_TILE_LABEL_SELECTED_CLASS
              : LAUNCHPAD_TILE_LABEL_CLASS
          }
        >
          {label}
        </span>
      </button>
    );
  }
);
LaunchpadWorkspaceCard.displayName = "LaunchpadWorkspaceCard";

interface LaunchpadAgentAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onLaunch: () => void;
  onOpenDetails: () => void;
}

interface LaunchpadAgentActionStripProps {
  agent: LaunchpadAgentAction;
}

const LaunchpadAgentActionStrip: React.FC<LaunchpadAgentActionStripProps> =
  memo(({ agent }) => {
    const { t } = useTranslation("navigation");

    return (
      <div className="w-full min-w-0 overflow-hidden rounded-full bg-fill-1 px-2 py-1.5">
        <div className="flex w-full min-w-0 items-center gap-1.5 overflow-x-auto scrollbar-hide">
          <Button
            variant="primary"
            size="small"
            shape="round"
            className="shrink-0"
            icon={<Play size={14} />}
            onClick={agent.onLaunch}
          >
            {t("navigation:launchpad.actions.startSession", {
              defaultValue: "Start session",
            })}
          </Button>
          <Button
            variant="secondary"
            size="small"
            shape="round"
            className="shrink-0"
            icon={<Expand size={14} />}
            onClick={agent.onOpenDetails}
          >
            {t("navigation:launchpad.actions.openDetails", {
              defaultValue: "Open details",
            })}
          </Button>
        </div>
      </div>
    );
  });
LaunchpadAgentActionStrip.displayName = "LaunchpadAgentActionStrip";

const LaunchpadDashboard: React.FC<LaunchpadDashboardProps> = memo(
  ({
    headerContent,
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
    // The dashboard lives inside the chat pane's Launchpad (start-page) tab.
    // Launching an agent switches to the Work sub-tab, whose session launcher
    // reads the creator state we just set. Navigating the outer route instead
    // (the old behavior) left the pane pinned on the dashboard → blank surface.
    const setStartPageTab = useSetAtom(chatPanelStartPageTabAtom);
    const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(
      null
    );
    const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
      null
    );
    const [refreshingAccountId, setRefreshingAccountId] = useState<
      string | null
    >(null);

    const {
      installedCliAgents,
      builtInRustAgents,
      customRustAgents,
      ready: catalogReady,
    } = useLaunchpadAgentCatalog();

    const {
      localAccounts,
      loading: keysLoading,
      refreshAccount,
    } = useKeyVault({ autoLoad: true });

    const {
      containers,
      loading: containersLoading,
      error: containersError,
      refresh: refreshContainers,
    } = useContainers();
    const {
      remoteEngines,
      loading: enginesLoading,
      error: enginesError,
      refresh: refreshEngines,
    } = useContainerEngines();

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
            setStartPageTab(CHAT_PANEL_START_PAGE_TAB.WORK);
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
            setStartPageTab(CHAT_PANEL_START_PAGE_TAB.WORK);
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
            setStartPageTab(CHAT_PANEL_START_PAGE_TAB.WORK);
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
      setStartPageTab,
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
        buildWizardPath(ROUTES.app.home.agentOrgs.path, WIZARD_IDS.AGENT_ADD)
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
            {headerContent}

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
