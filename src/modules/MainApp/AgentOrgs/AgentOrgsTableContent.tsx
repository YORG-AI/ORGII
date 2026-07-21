import type React from "react";

import type { AvailableAgent } from "@src/config/cliAgents";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import CliClientsTable from "@src/modules/MainApp/Integrations/KeyVault/CliClients/Table/CliClientsTable";
import type { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import { CliDisclaimer } from "@src/modules/MainApp/Integrations/Tables/TrademarkDisclaimer";

import AgentsTable from "./Table/AgentsTable";
import InlineExternalAgentsImport from "./Table/InlineExternalAgentsImport";
import OrgsTable from "./Table/OrgsTable";
import type { AgentDefinition, OrgMember } from "./types";

interface AgentOrgsTableContentProps {
  activeTab: "agents" | "orgs" | "clis";
  orgs: OrgMember[];
  orgsLoading: boolean;
  builtInAgents: AgentDefinition[];
  customAgents: AgentDefinition[];
  agentDefsLoading: boolean;
  cursorRepos: Array<{ name: string; path: string }>;
  accounts: KeyVaultAccount[];
  cliAgentControls: ReturnType<typeof useCliAgents>;
  onAddOrg: () => void;
  onDeleteOrg: (orgId: string) => Promise<void>;
  onAddAgent: () => void;
  onDeleteAgent: (agentId: string) => Promise<void>;
  onAgentImportRefresh: () => Promise<void>;
  onAddKey: () => void;
}

export function AgentOrgsTableContent({
  activeTab,
  orgs,
  orgsLoading,
  builtInAgents,
  customAgents,
  agentDefsLoading,
  cursorRepos,
  accounts,
  cliAgentControls,
  onAddOrg,
  onDeleteOrg,
  onAddAgent,
  onDeleteAgent,
  onAgentImportRefresh,
  onAddKey,
}: AgentOrgsTableContentProps): React.ReactNode {
  if (activeTab === "orgs") {
    return (
      <OrgsTable
        orgs={orgs}
        loading={orgsLoading}
        onAddOrg={onAddOrg}
        onDeleteOrg={onDeleteOrg}
      />
    );
  }
  if (activeTab === "clis") {
    return (
      <div className="flex flex-col gap-3">
        <CliClientsTable
          agents={cliAgentControls.agents as AvailableAgent[]}
          accounts={accounts}
          loading={cliAgentControls.loading}
          error={cliAgentControls.error}
          fetchAgents={cliAgentControls.fetchAgents}
          onAdd={onAddKey}
          cliAgents={cliAgentControls}
        />
        <CliDisclaimer />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <AgentsTable
        builtInAgents={builtInAgents}
        customAgents={customAgents}
        loading={agentDefsLoading}
        onAddAgent={onAddAgent}
        onDeleteAgent={onDeleteAgent}
      />
      <InlineExternalAgentsImport
        cursorRepos={cursorRepos}
        onAfterImport={onAgentImportRefresh}
      />
    </div>
  );
}
