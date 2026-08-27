import { useAtomValue } from "jotai";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import Switch from "@src/components/Switch";
import {
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import { LearningsBrowserContent } from "@src/modules/MainApp/Settings/subpages/LearningsBrowserPage/LearningsBrowserContent";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { useAgentLearnings } from "./useAgentLearnings";

const AGENT_SCOPE_PREFIX = "agent:";

function scopeForAgent(agentId: string): string {
  return `${AGENT_SCOPE_PREFIX}${agentId}`;
}

interface AgentEvolutionRowProps {
  agent: AgentDefinition;
}

function stripTrailingDescriptionPunctuation(value: string): string {
  return value.replace(/[.。]$/, "");
}

const AgentEvolutionRow: React.FC<AgentEvolutionRowProps> = ({ agent }) => {
  const { t } = useTranslation("settings");
  const learnings = useAgentLearnings(agent.id);

  if (!learnings.loaded) {
    return (
      <SectionRow
        label={t("agentEvolution.enableForAgent", { agentName: agent.name })}
        truncateLabel
      >
        <div className="h-5 w-9 animate-pulse rounded-full bg-fill-3" />
      </SectionRow>
    );
  }

  return (
    <div>
      <SectionRow
        label={t("agentEvolution.enableForAgent", { agentName: agent.name })}
        truncateLabel
      >
        <Switch
          checked={learnings.enabled}
          dataTestId={`rules-memory-evolution-agent-memory-enabled-${agent.id}`}
          onCheckedChange={learnings.setEnabled}
        />
      </SectionRow>
      <SectionRow
        label={t("agentMemory.extractMemoriesEnabled")}
        description={stripTrailingDescriptionPunctuation(
          t("agentMemory.extractMemoriesEnabledDesc")
        )}
        indent
      >
        <Switch
          checked={learnings.extractMemoriesEnabled}
          dataTestId={`rules-memory-evolution-agent-memory-extract-${agent.id}`}
          onCheckedChange={learnings.setExtractMemoriesEnabled}
          disabled={!learnings.enabled}
        />
      </SectionRow>
      <SectionRow
        label={t("agentMemory.autoDreamEnabled")}
        description={stripTrailingDescriptionPunctuation(
          t("agentMemory.autoDreamEnabledDesc")
        )}
        indent
      >
        <Switch
          checked={learnings.autoDreamEnabled}
          dataTestId={`rules-memory-evolution-agent-memory-auto-dream-${agent.id}`}
          onCheckedChange={learnings.setAutoDreamEnabled}
          disabled={!learnings.enabled}
        />
      </SectionRow>
    </div>
  );
};

const AgentEvolutionPanel: React.FC = () => {
  const { t } = useTranslation("settings");
  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const customAgents = useAtomValue(customAgentsAtom);

  const agents = useMemo(
    () => [...builtInAgents, ...customAgents],
    [builtInAgents, customAgents]
  );
  const agentScopes = useMemo(
    () => agents.map((agent) => scopeForAgent(agent.id)),
    [agents]
  );
  const agentScopeLabels = useMemo(
    () =>
      Object.fromEntries(
        agents.map((agent) => [scopeForAgent(agent.id), agent.name])
      ),
    [agents]
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionContainer>
        {agents.length > 0 ? (
          agents.map((agent) => (
            <AgentEvolutionRow key={agent.id} agent={agent} />
          ))
        ) : (
          <Placeholder
            variant="empty"
            title={t("agentEvolution.noAgentsTitle")}
            subtitle={t("agentEvolution.noAgentsSubtitle")}
          />
        )}
      </SectionContainer>

      <LearningsBrowserContent
        variant="integrationsPanel"
        agentScopes={agentScopes}
        agentScopeLabels={agentScopeLabels}
      />
    </div>
  );
};

export default AgentEvolutionPanel;
