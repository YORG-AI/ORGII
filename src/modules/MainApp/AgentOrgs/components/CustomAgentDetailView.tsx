/**
 * CustomAgentDetailView — Tabbed detail view for user-defined agents
 * and non-core built-in agents that use the custom-agent editor path.
 *
 * Mirrors `BuiltInAgentDetailView` (OS / SDE) so every agent on the
 * Members panel surfaces the same tabbed editor — General / Models /
 * Subagents / Tools / Skills, MCPs, Plugins — instead of a flat read-only Overview
 * placeholder. Security settings live in General.
 *
 * Wires the reusable section components (`SecuritySection`,
 * `AgentMcpSection`, `AgentSkillsSection`, `SubAgentsEditor`,
 * `PersonalitySection`) through
 * `useCustomAgentConfig`, which projects the typed `AgentDefinition`
 * onto the section-shape the OS / SDE editors expect.
 */
import { useAtom, useAtomValue } from "jotai";
import { Trash2, X } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import type { TabPillItem } from "@src/components/TabPill";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  PANEL_HEADER_TOKENS,
} from "@src/modules/shared/layouts/blocks";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";

import {
  getAgentDetailTabs,
  isFullHeightAgentTab,
} from "../config/agentDetailTabs";
import CustomAgentToolsSection from "../config/customAgent/CustomAgentToolsSection";
import { useCustomAgentConfig } from "../config/customAgent/useCustomAgentConfig";
import SecuritySection from "../config/osAgent/sections/SecuritySection";
import AgentRulesSection from "../config/rules/AgentRulesSection";
import AgentModelsSection from "../config/shared/AgentModelsSection";
import AgentRuntimeLimitsSection from "../config/shared/AgentRuntimeLimitsSection";
import PersonalitySection from "../config/shared/PersonalitySection";
import SubAgentsEditor from "../config/shared/SubAgentsEditor";
import AgentSkillsetsSection from "../config/skills/AgentSkillsetsSection";
import { useAgentDefinitions } from "../hooks/useAgentDefinitions";
import { agentOrgsActiveTabAtom } from "../store/agentOrgsActiveTabAtom";
import type { AgentDefinition, SubAgentRef } from "../types";
import AgentDetailHeader from "./AgentDetailHeader";

/**
 * Caller-supplied extra tab. Used by `WingmanDetailView` to splice in
 * Cursor Style + Desktop Safety panels without reimplementing the rest
 * of the tabbed editor.
 */
export interface CustomAgentExtraTab {
  key: string;
  label: string;
  content: React.ReactNode;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface CustomAgentDetailViewProps {
  agent: AgentDefinition;
  onAgentDelete: (agentId: string) => void;
  /** Optional extra tabs appended after the standard set. */
  extraTabs?: CustomAgentExtraTab[];
  hideIdentityTitle?: boolean;
}

const CustomAgentDetailView: React.FC<CustomAgentDetailViewProps> = ({
  agent,
  onAgentDelete,
  extraTabs,
  hideIdentityTitle = false,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");
  const [activeTab, setActiveTab] = useAtom(agentOrgsActiveTabAtom);
  const [deletePendingAgentId, setDeletePendingAgentId] = useState<
    string | null
  >(null);
  const { refresh } = useAgentDefinitions();

  // Reset to General whenever the selected agent changes so the user
  // never lands on a tab that belongs to a different agent's context.
  useEffect(() => {
    setActiveTab("general");
  }, [agent.id, setActiveTab]);

  const persist = useCallback(
    async (patch: Record<string, unknown>) => {
      let nextPatch = patch;
      if (isPlainRecord(patch.tools)) {
        const latest = (await rpc.agentDef.get({
          agentId: agent.id,
        })) as unknown;
        const latestTools = isPlainRecord(
          (latest as AgentDefinition | null)?.tools
        )
          ? ((latest as AgentDefinition).tools as Record<string, unknown>)
          : {};
        nextPatch = {
          ...patch,
          tools: {
            ...latestTools,
            ...patch.tools,
          },
        };
      }
      await rpc.agentDef.updatePatch({ agentId: agent.id, patch: nextPatch });
      await refresh({ forceFresh: true });
    },
    [agent.id, refresh]
  );

  const workspacePath = useAtomValue(activeWorkspaceRootPathAtom) || undefined;

  const configHandle = useCustomAgentConfig({ agent, onPersist: persist });
  const { config, loaded, update } = configHandle;

  // Stable hook reference for AgentMcpSection (which expects a hook signature).
  const useConfigForMcp = useCallback(() => configHandle, [configHandle]);

  const tabs = useMemo<TabPillItem[]>(
    () =>
      getAgentDetailTabs(
        "custom",
        tSettings,
        t,
        extraTabs?.map(({ key, label }) => ({ key, label }))
      ),
    [t, tSettings, extraTabs]
  );

  const extraTab = extraTabs?.find((tab) => tab.key === activeTab);

  const subAgents = useMemo<SubAgentRef[]>(() => {
    return Array.isArray(agent.subAgents) ? agent.subAgents : [];
  }, [agent.subAgents]);

  const handleSubAgentsChange = useCallback(
    (refs: SubAgentRef[]) => {
      // Send `[]` for clear, never `null`: AgentDefinitionPatch
      // treats `None` as "leave unchanged", so the empty-list-as-null
      // mapping would silently swallow the user's "remove all" gesture.
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

  const deletePending = deletePendingAgentId === agent.id;

  const handleDeleteRequest = useCallback(() => {
    setDeletePendingAgentId(agent.id);
  }, [agent.id]);

  const handleDeleteCancel = useCallback(() => {
    setDeletePendingAgentId(null);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    onAgentDelete(agent.id);
  }, [agent.id, onAgentDelete]);

  // Built-in agents (Rust definitions: base/os/sde/wingman/...) carry
  // `built_in: true` from the backend; the CRUD endpoint refuses to
  // delete them, so the trash button is hidden here. Wingman supplies a
  // `noop` `onAgentDelete` because it reuses this component as a thin
  // wrapper. INTERNAL_AGENT_IDS (explore/general/memory-*) never reach
  // this view because `useAgentDefinitions` filters them out of the
  // visible list.
  const actions = useMemo(() => {
    if (agent.builtIn) return undefined;

    if (deletePending) {
      return (
        <div className="flex items-center gap-1">
          <Button
            variant="danger"
            appearance="solid"
            size="mini"
            shape="round"
            data-testid="agent-orgs-confirm-delete-agent-button"
            onClick={handleDeleteConfirm}
            title={t("common:actions.delete")}
          >
            {t("common:actions.delete")}
          </Button>
          <Button
            {...PANEL_HEADER_TOKENS.actionButton}
            icon={
              <X
                size={PANEL_HEADER_TOKENS.buttonIconSize}
                strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
              />
            }
            data-testid="agent-orgs-cancel-delete-agent-button"
            onClick={handleDeleteCancel}
            title={t("common:actions.cancel")}
          />
        </div>
      );
    }

    return (
      <Button
        {...PANEL_HEADER_TOKENS.dangerButton}
        icon={
          <Trash2
            size={PANEL_HEADER_TOKENS.buttonIconSize}
            strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
          />
        }
        data-testid="agent-orgs-delete-agent-button"
        onClick={handleDeleteRequest}
        title={t("common:actions.delete")}
      />
    );
  }, [
    agent.builtIn,
    deletePending,
    handleDeleteConfirm,
    handleDeleteCancel,
    handleDeleteRequest,
    t,
  ]);

  const headerElement = useMemo(
    () => (
      <AgentDetailHeader
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        actions={actions}
      />
    ),
    [tabs, activeTab, setActiveTab, actions]
  );
  const rootProps = useMemo(
    () =>
      ({
        "data-active-tab": activeTab,
      }) as React.HTMLAttributes<HTMLDivElement>,
    [activeTab]
  );

  if (!loaded) {
    return (
      <DetailPanelContainer
        testId="agent-orgs-custom-detail"
        rootProps={rootProps}
      >
        {headerElement}
        <Placeholder variant="loading" />
      </DetailPanelContainer>
    );
  }

  const isFullHeight = isFullHeightAgentTab(activeTab);

  if (isFullHeight) {
    if (activeTab === "tools") {
      return (
        <DetailPanelContainer
          testId="agent-orgs-custom-detail"
          rootProps={rootProps}
        >
          <CustomAgentToolsSection
            agentId={agent.id}
            headerElement={headerElement}
          />
        </DetailPanelContainer>
      );
    }
    if (activeTab === "skillsets") {
      return (
        <div
          className="flex h-full flex-col"
          data-active-tab={activeTab}
          data-testid="agent-orgs-custom-detail"
        >
          <AgentSkillsetsSection
            headerElement={headerElement}
            agentId={agent.id}
            workspacePath={workspacePath}
            useConfig={useConfigForMcp}
          />
        </div>
      );
    }
  }

  return (
    <DetailPanelContainer
      testId="agent-orgs-custom-detail"
      rootProps={rootProps}
    >
      {headerElement}
      <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          {activeTab === "general" && (
            <div className="flex flex-col gap-3">
              <SectionContainer
                title={
                  hideIdentityTitle
                    ? undefined
                    : tSettings("sharedAgentConfig.identity.title")
                }
              >
                <SectionRow label={t("agentOrgs.agentWizard.nameLabel")}>
                  {agent.builtIn ? (
                    <span className="text-sm text-text-1">{agent.name}</span>
                  ) : (
                    <Input
                      value={(config.name as string | undefined) ?? agent.name}
                      onChange={(value) => update("name", value)}
                      style={SECTION_CONTROL_STYLE}
                      data-testid="agent-orgs-custom-name-input"
                    />
                  )}
                </SectionRow>
                <SectionRow
                  label={t("agentOrgs.agentWizard.descriptionLabel")}
                  layout="vertical"
                >
                  {agent.builtIn ? (
                    <span className="text-sm text-text-1">
                      {agent.description ?? ""}
                    </span>
                  ) : (
                    <Input
                      value={
                        (config.description as string | undefined) ??
                        agent.description ??
                        ""
                      }
                      onChange={(value) => update("description", value)}
                      style={{ width: "100%" }}
                      data-testid="agent-orgs-custom-description-input"
                    />
                  )}
                </SectionRow>
              </SectionContainer>
              <PersonalitySection config={config} update={update} />
              <AgentRuntimeLimitsSection
                config={config}
                update={update}
                defaultExecTimeoutSeconds={120}
                defaultMaxIterations={
                  (agent.sessionModel?.maxIterations as number | undefined) ??
                  500
                }
              />
              <SecuritySection config={config} update={update} />
            </div>
          )}

          {activeTab === "models" && (
            <AgentModelsSection config={config} update={update} />
          )}

          {activeTab === "subagents" && (
            <SubAgentsEditor
              subAgents={subAgents}
              onChange={handleSubAgentsChange}
              maxToolUseConcurrency={agent.maxToolUseConcurrency ?? 10}
              onMaxToolUseConcurrencyChange={handleMaxToolUseConcurrencyChange}
              currentAgentId={agent.id}
              t={t}
            />
          )}

          {activeTab === "rules" && (
            <AgentRulesSection
              workspacePath={workspacePath}
              config={config}
              update={update}
            />
          )}

          {extraTab && extraTab.content}
        </div>
      </div>
    </DetailPanelContainer>
  );
};

export default CustomAgentDetailView;
