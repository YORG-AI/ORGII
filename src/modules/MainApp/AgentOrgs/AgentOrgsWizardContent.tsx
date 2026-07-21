import AgentWizard from "@src/scaffold/WizardSystem/variants/Agent/AgentWizard";
import AgentTeamWizard from "@src/scaffold/WizardSystem/variants/AgentOrg/AgentTeamWizard";

import type { AgentDefinition, AvailableCliAgent, OrgMember } from "./types";

interface AgentOrgsWizardContentProps {
  teamWizardMode: boolean;
  agentWizardMode: boolean;
  editingOrg?: OrgMember;
  customAgents: AgentDefinition[];
  cliAgents: AvailableCliAgent[];
  onTeamSave: (org: OrgMember) => Promise<void>;
  onAgentSave: (agent: AgentDefinition) => Promise<void>;
  onCliAgentRefresh: () => Promise<void>;
  onCancel: () => void;
}

export function AgentOrgsWizardContent({
  teamWizardMode,
  agentWizardMode,
  editingOrg,
  customAgents,
  cliAgents,
  onTeamSave,
  onAgentSave,
  onCliAgentRefresh,
  onCancel,
}: AgentOrgsWizardContentProps) {
  if (teamWizardMode) {
    return (
      <AgentTeamWizard
        key={editingOrg?.id ?? "new"}
        onSave={onTeamSave}
        onCancel={onCancel}
        initialOrg={editingOrg}
        customAgents={customAgents}
        cliAgents={cliAgents}
        onCliAgentRefresh={onCliAgentRefresh}
        onAgentCreate={onAgentSave}
      />
    );
  }
  if (agentWizardMode) {
    return <AgentWizard onSave={onAgentSave} onCancel={onCancel} />;
  }
  return null;
}
