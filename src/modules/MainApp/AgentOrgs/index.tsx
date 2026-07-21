/**
 * Agent Teams — main page module.
 *
 * The Agent Teams surface uses one top-level settings route with an internal
 * table switcher for Agents, Teams, and CLIs. Entity rows open their full
 * configuration detail UI inside WorkStation `agent-config` tabs.
 */
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { rpc } from "@src/api/tauri/rpc";
import { Message } from "@src/components/Message";
import TabPill from "@src/components/TabPill";
import {
  type AgentOrgsTabSegment,
  WIZARD_IDS,
  buildAgentOrgsPath,
  buildIntegrationsPath,
  buildWizardPath,
  parseAgentOrgsPath,
} from "@src/config/mainAppPaths";
import { useKeyVault } from "@src/hooks/keyVault";
import { createLogger } from "@src/hooks/logger";
import { useWizardParam } from "@src/hooks/navigation";
import { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import {
  DETAIL_PANEL_TOKENS,
  InternalHeader,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { reposAtom } from "@src/store/repo/atoms";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { AgentOrgsTableContent } from "./AgentOrgsTableContent";
import { AgentOrgsWizardContent } from "./AgentOrgsWizardContent";
import { useAgentDefinitions } from "./hooks/useAgentDefinitions";
import { useAgentOrgsDirectory } from "./hooks/useAgentOrgsDirectory";
import { useInstalledCliAgents } from "./hooks/useInstalledCliAgents";
import {
  resolveAgentOrgsTableTab,
  resolveLegacyAgentOrgsRedirect,
} from "./model";
import { builtInAgentsAtom } from "./store/builtInAgentsAtom";
import type { AgentDefinition, OrgMember } from "./types";

const logger = createLogger("AgentOrgs");

const TABLE_TABS: Array<{
  key: AgentOrgsTabSegment;
  labelKey: string;
  defaultLabel: string;
}> = [
  {
    key: "agents",
    labelKey: "agentOrgs.tableTabs.agents",
    defaultLabel: "Agents",
  },
  { key: "orgs", labelKey: "agentOrgs.tableTabs.orgs", defaultLabel: "Orgs" },
  { key: "clis", labelKey: "agentOrgs.tableTabs.clis", defaultLabel: "CLIs" },
];

const AgentOrgsPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation("integrations");

  const parsed = useMemo(
    () => parseAgentOrgsPath(location.pathname),
    [location.pathname]
  );

  useEffect(() => {
    if (resolveLegacyAgentOrgsRedirect(location.pathname)) {
      navigate(
        `${buildAgentOrgsPath({ tab: "orgs" })}${location.search}${location.hash}`,
        { replace: true }
      );
    }
  }, [location.pathname, location.search, location.hash, navigate]);

  const activeTab: AgentOrgsTabSegment = parsed.tab;
  const activeTableTab = resolveAgentOrgsTableTab(activeTab);

  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const repos = useAtomValue(reposAtom);
  const cursorRepos = useMemo(
    () =>
      repos
        .filter((repo): repo is typeof repo & { path: string } => !!repo.path)
        .map((repo) => ({ name: repo.name, path: repo.path })),
    [repos]
  );

  const {
    agents: customAgents,
    addAgent,
    removeAgent,
    refresh: refreshAgentDefinitions,
    loading: agentDefsLoading,
    loadError: agentDefsLoadError,
  } = useAgentDefinitions();

  const lastReportedErrorRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!agentDefsLoadError) {
      lastReportedErrorRef.current = null;
      return;
    }
    if (lastReportedErrorRef.current === agentDefsLoadError) return;
    lastReportedErrorRef.current = agentDefsLoadError;
    Message.error(
      t("agentOrgs.agentLoadFailed", {
        defaultValue: "Failed to load agent definitions",
      })
    );
  }, [agentDefsLoadError, t]);

  const { accounts } = useKeyVault({ autoLoad: true });
  const cliAgentControls = useCliAgents({ enabled: activeTableTab === "clis" });
  const { cliAgents, refreshInstalledCliAgents } = useInstalledCliAgents();

  const { wizard, entityId, openWizard, closeWizard } = useWizardParam();
  const teamWizardMode =
    wizard === WIZARD_IDS.ORG_ADD || wizard === WIZARD_IDS.ORG_EDIT;
  const orgEditId = wizard === WIZARD_IDS.ORG_EDIT ? entityId : null;
  const agentWizardMode = wizard === WIZARD_IDS.AGENT_ADD;

  const { orgs, setOrgs, orgsLoading, loadOrgs } = useAgentOrgsDirectory();

  const editingOrg = useMemo<OrgMember | undefined>(
    () => (orgEditId ? orgs.find((org) => org.id === orgEditId) : undefined),
    [orgEditId, orgs]
  );

  const handleOrgAdd = useCallback(() => {
    openWizard(WIZARD_IDS.ORG_ADD);
  }, [openWizard]);

  const handleTeamWizardSave = useCallback(
    async (org: OrgMember) => {
      const isUpdate = orgs.some((existing) => existing.id === org.id);
      const orgJson = JSON.stringify(org);
      try {
        if (isUpdate) {
          await rpc.agentOrgs.orgs.update({ orgJson });
        } else {
          await rpc.agentOrgs.orgs.add({ orgJson });
        }
        const refreshed = await loadOrgs();
        setOrgs(refreshed);
        closeWizard();
        Message.success(
          t(isUpdate ? "agentOrgs.orgUpdated" : "agentOrgs.orgCreated", {
            defaultValue: isUpdate
              ? "Organization updated"
              : "Organization created",
          })
        );
      } catch (err) {
        logger.error("save failed", err);
        Message.error(
          t("agentOrgs.orgSaveFailed", {
            defaultValue: "Failed to save organization",
          })
        );
      }
    },
    [orgs, loadOrgs, setOrgs, closeWizard, t]
  );

  const handleOrgDelete = useCallback(
    async (orgId: string) => {
      const target = orgs.find((org) => org.id === orgId);
      const confirmed = await confirmDestructiveAction({
        title: t("agentOrgs.deleteOrgTitle", {
          defaultValue: "Delete team?",
        }),
        message: t("agentOrgs.deleteOrgMessage", {
          name: target?.name ?? "this team",
          defaultValue: `"${target?.name ?? "this team"}" will be permanently removed. This cannot be undone.`,
        }),
        okLabel: t("common:actions.delete", { defaultValue: "Delete" }),
        cancelLabel: t("common:actions.cancel", { defaultValue: "Cancel" }),
      });
      if (!confirmed) return;

      try {
        await rpc.agentOrgs.orgs.remove({ orgId });
        const refreshed = await loadOrgs();
        setOrgs(refreshed);
        Message.success(
          t("agentOrgs.orgDeleted", { defaultValue: "Team deleted" })
        );
      } catch (err) {
        logger.error("delete failed", err);
        Message.error(
          t("agentOrgs.orgDeleteFailed", {
            defaultValue: "Failed to delete team",
          })
        );
      }
    },
    [orgs, loadOrgs, setOrgs, t]
  );

  const handleAgentAdd = useCallback(() => {
    openWizard(WIZARD_IDS.AGENT_ADD);
  }, [openWizard]);

  const handleKeyAdd = useCallback(() => {
    const accountsPath = `${buildIntegrationsPath({
      category: "models",
    })}?modelsTab=my-accounts`;
    navigate(buildWizardPath(accountsPath, WIZARD_IDS.KEY_ADD));
  }, [navigate]);

  const handleAgentImportRefresh = useCallback(async () => {
    await refreshAgentDefinitions({ forceFresh: true });
  }, [refreshAgentDefinitions]);

  const handleAgentWizardSave = useCallback(
    async (agent: AgentDefinition) => {
      try {
        await addAgent(agent);
        closeWizard();
        Message.success(
          t("agentOrgs.agentSaved", { defaultValue: "Agent saved" })
        );
      } catch (err) {
        logger.error("agent save failed", err);
        Message.error(
          t("agentOrgs.agentSaveFailed", {
            defaultValue: "Failed to save agent",
          })
        );
      }
    },
    [addAgent, closeWizard, t]
  );

  const handleAgentDelete = useCallback(
    async (agentId: string) => {
      try {
        await removeAgent(agentId);
        Message.success(
          t("agentOrgs.agentDeleted", { defaultValue: "Agent deleted" })
        );
      } catch (err) {
        logger.error("agent delete failed", err);
        Message.error(
          t("agentOrgs.agentDeleteFailed", {
            defaultValue: "Failed to delete agent",
          })
        );
      }
    },
    [removeAgent, t]
  );

  const tabs = TABLE_TABS.map((tab) => ({
    key: tab.key,
    label: t(tab.labelKey, { defaultValue: tab.defaultLabel }),
  }));

  const setActiveTableTab = (tab: string) => {
    navigate(buildAgentOrgsPath({ tab: tab as AgentOrgsTabSegment }));
  };

  const wizardContent =
    teamWizardMode || agentWizardMode ? (
      <AgentOrgsWizardContent
        teamWizardMode={teamWizardMode}
        agentWizardMode={agentWizardMode}
        editingOrg={editingOrg}
        customAgents={customAgents}
        cliAgents={cliAgents}
        onTeamSave={handleTeamWizardSave}
        onAgentSave={handleAgentWizardSave}
        onCliAgentRefresh={refreshInstalledCliAgents}
        onCancel={closeWizard}
      />
    ) : null;

  if (wizardContent) {
    return (
      <div className="settings-page absolute inset-0 flex flex-col overflow-hidden">
        {wizardContent}
      </div>
    );
  }

  return (
    <div className="settings-page absolute inset-0 flex flex-col overflow-hidden">
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <TabPill
            tabs={tabs}
            activeTab={activeTableTab}
            onChange={setActiveTableTab}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
      />
      <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          <AgentOrgsTableContent
            activeTab={activeTableTab as "agents" | "orgs" | "clis"}
            orgs={orgs}
            orgsLoading={orgsLoading}
            builtInAgents={builtInAgents}
            customAgents={customAgents}
            agentDefsLoading={agentDefsLoading}
            cursorRepos={cursorRepos}
            accounts={accounts}
            cliAgentControls={cliAgentControls}
            onAddOrg={handleOrgAdd}
            onDeleteOrg={handleOrgDelete}
            onAddAgent={handleAgentAdd}
            onDeleteAgent={handleAgentDelete}
            onAgentImportRefresh={handleAgentImportRefresh}
            onAddKey={handleKeyAdd}
          />
        </div>
      </ScrollPreservation>
    </div>
  );
};

export default AgentOrgsPage;
