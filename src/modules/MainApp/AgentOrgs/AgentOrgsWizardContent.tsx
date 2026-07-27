import AgentWizard from "@src/scaffold/WizardSystem/variants/Agent/AgentWizard";
import AgentTeamWizard from "@src/scaffold/WizardSystem/variants/AgentOrg/AgentTeamWizard";

import type { AgentDefinition, OrgMember } from "./types";

interface AgentOrgsWizardContentProps {
  teamWizardMode: boolean;
  agentWizardMode: boolean;
  editingOrg?: OrgMember;
  customAgents: AgentDefinition[];
  onTeamSave: (org: OrgMember) => Promise<void>;
  onAgentSave: (agent: AgentDefinition) => Promise<void>;
  onCancel: () => void;
}

export function AgentOrgsWizardContent({
  teamWizardMode,
  agentWizardMode,
  editingOrg,
  customAgents,
  onTeamSave,
  onAgentSave,
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
        onAgentCreate={onAgentSave}
      />
    );
  }
  if (agentWizardMode) {
    return <AgentWizard onSave={onAgentSave} onCancel={onCancel} />;
  }
  return null;
}
