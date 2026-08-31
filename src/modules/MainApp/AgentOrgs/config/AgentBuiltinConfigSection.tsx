/**
 * AgentBuiltinConfigSection — Unified config UI for OS Agent and SDE Agent.
 *
 * Both agents share the same core tabs (General / Models / Subagents / Tools /
 * Skills, MCPs, Plugins / Rules). Security settings live in General.
 * Differences are small:
 *   - OS: Security hides workspace-only toggle and General shows workspace path.
 *   - SDE: workspacePath is used for Skills/Rules.
 *
 * Tabs can be controlled externally via `activeTab`/`onTabChange` (for lifting
 * into a PanelHeader tab-bar). When omitted the component manages them itself.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import type { TabPillItem } from "@src/components/TabPill";
import type { SubAgentRef } from "@src/modules/MainApp/AgentOrgs/types";
import { SectionTabSwitch } from "@src/modules/shared/layouts/SectionLayout";
import {
  BUILTIN_OS_DEF_ID,
  BUILTIN_SDE_DEF_ID,
} from "@src/util/session/sessionDispatch";

import { getAgentDetailTabs, isFullHeightAgentTab } from "./agentDetailTabs";
import CustomAgentToolsSection from "./customAgent/CustomAgentToolsSection";
import ConfigGeneralSection from "./osAgent/sections/ConfigGeneralSection";
import SecuritySection from "./osAgent/sections/SecuritySection";
import { useOSAgentConfig } from "./osAgent/useOSAgentConfig";
import AgentRulesSection from "./rules/AgentRulesSection";
import { useSdeAgentConfig } from "./sdeAgent/useSdeAgentConfig";
import AgentModelsSection from "./shared/AgentModelsSection";
import PersonalitySection from "./shared/PersonalitySection";
import SubAgentsEditor from "./shared/SubAgentsEditor";
import AgentSkillsetsSection from "./skills/AgentSkillsetsSection";

export type AgentBuiltinKind = "os" | "sde";

export function useOSAgentTabs(): TabPillItem[] {
  const { t: tSettings } = useTranslation("settings");
  const { t: tIntegrations } = useTranslation("integrations");
  return useMemo<TabPillItem[]>(
    () => getAgentDetailTabs("os", tSettings, tIntegrations),
    [tSettings, tIntegrations]
  );
}

export function useSdeAgentTabs(): TabPillItem[] {
  const { t: tSettings } = useTranslation("settings");
  const { t: tIntegrations } = useTranslation("integrations");
  return useMemo<TabPillItem[]>(
    () => getAgentDetailTabs("sde", tSettings, tIntegrations),
    [tSettings, tIntegrations]
  );
}

interface AgentBuiltinConfigSectionProps {
  kind: AgentBuiltinKind;
  /** Workspace path — SDE only; Skills / Rules / MCP are workspace-scoped. */
  workspacePath?: string;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
}

const AgentBuiltinConfigSection: React.FC<AgentBuiltinConfigSectionProps> = ({
  kind,
  workspacePath,
  activeTab: externalTab,
  onTabChange,
}) => {
  const { t: tIntegrations } = useTranslation("integrations");

  const osConfig = useOSAgentConfig();
  const sdeConfig = useSdeAgentConfig(
    kind === "sde" ? workspacePath : undefined
  );

  const { config, loaded, update } = kind === "os" ? osConfig : sdeConfig;

  // Stable hook reference for AgentMcpSection (which expects a no-arg hook).
  // Both closures capture the already-loaded config via the hook called above,
  // so MCP re-renders stay consistent with the rest of the tab content.
  const useOSConfigForMcp = useCallback(() => osConfig, [osConfig]);
  const useSdeConfigForMcp = useCallback(() => sdeConfig, [sdeConfig]);

  const osTabs = useOSAgentTabs();
  const sdeTabs = useSdeAgentTabs();
  const tabs = kind === "os" ? osTabs : sdeTabs;

  const agentId = kind === "os" ? BUILTIN_OS_DEF_ID : BUILTIN_SDE_DEF_ID;

  const [internalTab, setInternalTab] = useState("general");
  const activeTab = externalTab ?? internalTab;
  const setActiveTab = onTabChange ?? setInternalTab;
  const isExternallyControlled = externalTab !== undefined;

  const subAgents = useMemo<SubAgentRef[]>(() => {
    const raw = config.subAgents;
    if (!Array.isArray(raw)) return [];
    return raw as SubAgentRef[];
  }, [config.subAgents]);

  const handleSubAgentsChange = useCallback(
    (refs: SubAgentRef[]) => {
      update("subAgents", refs);
    },
    [update]
  );

  const handleMaxToolUseConcurrencyChange = useCallback(
    (value: number) => {
      update("maxToolUseConcurrency", value);
    },
    [update]
  );

  if (!loaded) return <Placeholder variant="loading" />;

  const isFullHeightTab = isFullHeightAgentTab(activeTab);

  return (
    <div
      className={
        isFullHeightTab ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-3"
      }
    >
      {!isExternallyControlled && (
        <SectionTabSwitch
          tabs={tabs}
          activeTab={activeTab}
          onChange={setActiveTab}
        />
      )}

      {activeTab === "general" && (
        <>
          {kind === "os" ? (
            <ConfigGeneralSection config={config} update={update} />
          ) : null}
          <PersonalitySection config={config} update={update} />
          <SecuritySection
            config={config}
            update={update}
            accessModeEditable={false}
            hideWorkspaceRestriction={kind === "os"}
          />
        </>
      )}

      {activeTab === "models" && (
        <AgentModelsSection config={config} update={update} />
      )}

      {activeTab === "subagents" && (
        <SubAgentsEditor
          subAgents={subAgents}
          onChange={handleSubAgentsChange}
          maxToolUseConcurrency={config.maxToolUseConcurrency as number | null}
          onMaxToolUseConcurrencyChange={handleMaxToolUseConcurrencyChange}
          currentAgentId={agentId}
          t={tIntegrations}
        />
      )}

      {activeTab === "tools" && <CustomAgentToolsSection agentId={agentId} />}

      {activeTab === "skillsets" && (
        <AgentSkillsetsSection
          agentId={agentId}
          workspacePath={kind === "sde" ? workspacePath : undefined}
          useConfig={kind === "os" ? useOSConfigForMcp : useSdeConfigForMcp}
        />
      )}

      {activeTab === "rules" && (
        <AgentRulesSection
          workspacePath={kind === "sde" ? workspacePath : undefined}
          config={config}
          update={update}
        />
      )}
    </div>
  );
};

export default AgentBuiltinConfigSection;
