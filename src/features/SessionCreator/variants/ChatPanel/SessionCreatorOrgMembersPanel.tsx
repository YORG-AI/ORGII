import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { type CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import {
  DISPATCH_CATEGORY,
  type DispatchCategory,
} from "@src/api/tauri/session";
import AnyIcon from "@src/components/AnyIcon";
import { PILL_SM_ICON_SIZE } from "@src/components/CompoundPill/config";
import ModelIcon from "@src/components/ModelIcon";
import ModelSelectionBreadcrumb from "@src/components/ModelSelectionBreadcrumb";
import SelectorPill from "@src/components/SelectorPill";
import Switch from "@src/components/Switch";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { useModelPillLabel } from "@src/hooks/models";
import { AiSettingIcon, HugeiconsIcon, UserMultipleIcon } from "@src/icons";
import {
  type AgentDefinition,
  type AvailableCliAgent,
  CLI_AGENT_PREFIX,
  type OrgMember,
  type OrgMemberLaunchOverride,
  type OrgMemberRuntimeConfig,
} from "@src/modules/MainApp/AgentOrgs/types";
import { DispatchCategoryPalette } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { UnifiedModelPalette } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette";
import { flattenOrgToMembers } from "@src/scaffold/WizardSystem/variants/AgentOrg/orgTree";
import {
  BUILTIN_SDE_DEF_ID,
  SDE_AGENT_ICON_ID,
} from "@src/util/session/sessionDispatch";

import {
  applyAgentRuntimeConfig,
  toAgentRuntimeConfig,
} from "../../agentRuntimeConfig";
import type { AdvancedConfig } from "../../types";

interface SessionCreatorOrgMembersPanelProps {
  org: OrgMember;
  advancedConfig: AdvancedConfig;
  onAdvancedConfigChange: (config: AdvancedConfig) => void;
  allAgents: AgentDefinition[];
  cliAgents: AvailableCliAgent[];
  className?: string;
}

interface MemberView {
  id: string;
  name: string;
  agentId: string;
  runtimeConfig?: OrgMemberRuntimeConfig;
}

function resolveAgentIdFromSelection(
  selection: AgentSelection
): string | undefined {
  if (
    selection.category === DISPATCH_CATEGORY.CLI_AGENT &&
    selection.cliAgentType
  ) {
    return `${CLI_AGENT_PREFIX}${selection.cliAgentType}`;
  }
  return selection.agentDefinitionId;
}

function resolveDispatchForAgentId(agentId: string): {
  dispatchCategory: DispatchCategory;
  cliAgentType?: CliAgentType;
} {
  if (agentId.startsWith(CLI_AGENT_PREFIX)) {
    return {
      dispatchCategory: DISPATCH_CATEGORY.CLI_AGENT,
      cliAgentType: agentId.slice(CLI_AGENT_PREFIX.length) as CliAgentType,
    };
  }
  return { dispatchCategory: DISPATCH_CATEGORY.RUST_AGENT };
}

function resolveMemberAgent(
  agentId: string,
  allAgents: AgentDefinition[],
  cliAgents: AvailableCliAgent[]
): { label: string; iconId: string | null; cliAgentType: string | null } {
  if (agentId.startsWith(CLI_AGENT_PREFIX)) {
    const cliName = agentId.slice(CLI_AGENT_PREFIX.length);
    const cli = cliAgents.find((agent) => agent.name === cliName);
    return {
      label: cli?.displayName ?? cliName,
      iconId: null,
      cliAgentType: cliName,
    };
  }
  const definition = allAgents.find((agent) => agent.id === agentId);
  return {
    label: definition?.name ?? agentId,
    iconId:
      definition?.iconId ??
      (agentId === BUILTIN_SDE_DEF_ID ? SDE_AGENT_ICON_ID : "code"),
    cliAgentType: null,
  };
}

const SessionCreatorOrgMembersPanel: React.FC<SessionCreatorOrgMembersPanelProps> =
  memo(
    ({
      org,
      advancedConfig,
      onAdvancedConfigChange,
      allAgents,
      cliAgents,
      className = "",
    }) => {
      const { t } = useTranslation("sessions");

      const members: MemberView[] = useMemo(
        () =>
          flattenOrgToMembers(org.children).map((member) => {
            const override =
              advancedConfig.agentOrgMemberOverrides?.[member.id] ?? {};
            return {
              id: member.id,
              name: member.name,
              agentId: override.agentId ?? member.agentId,
              runtimeConfig: override.runtimeConfig ?? member.runtimeConfig,
            };
          }),
        [advancedConfig.agentOrgMemberOverrides, org.children]
      );

      const defaultModelLabel = t("creator.model");
      const {
        label: globalModelLabel,
        title: globalModelTitle,
        accountName: globalModelAccountName,
      } = useModelPillLabel(advancedConfig, defaultModelLabel);

      const updateMemberOverride = useCallback(
        (
          memberId: string,
          updater: (current: OrgMemberLaunchOverride) => OrgMemberLaunchOverride
        ) => {
          const currentOverrides = advancedConfig.agentOrgMemberOverrides ?? {};
          onAdvancedConfigChange({
            ...advancedConfig,
            agentOrgMemberOverrides: {
              ...currentOverrides,
              [memberId]: updater(currentOverrides[memberId] ?? {}),
            },
          });
        },
        [advancedConfig, onAdvancedConfigChange]
      );

      const [modelPickerMemberId, setModelPickerMemberId] = useState<
        string | null
      >(null);
      const modelPickerMember = useMemo(
        () =>
          members.find((member) => member.id === modelPickerMemberId) ?? null,
        [members, modelPickerMemberId]
      );
      const modelPickerConfig = useMemo(
        () =>
          modelPickerMember
            ? applyAgentRuntimeConfig(
                advancedConfig,
                modelPickerMember.runtimeConfig
              )
            : advancedConfig,
        [advancedConfig, modelPickerMember]
      );
      const modelPickerDispatch = modelPickerMember
        ? resolveDispatchForAgentId(modelPickerMember.agentId)
        : undefined;

      const handleModelConfigChange = useCallback(
        (config: AdvancedConfig) => {
          if (!modelPickerMemberId) return;
          updateMemberOverride(modelPickerMemberId, (current) => ({
            ...current,
            runtimeConfig: toAgentRuntimeConfig(config),
          }));
        },
        [modelPickerMemberId, updateMemberOverride]
      );

      const [agentPickerMemberId, setAgentPickerMemberId] = useState<
        string | null
      >(null);
      const isAgentPickerOpen = agentPickerMemberId !== null;
      const agentPickerMember = useMemo(
        () =>
          members.find((member) => member.id === agentPickerMemberId) ?? null,
        [members, agentPickerMemberId]
      );
      const handleCloseAgentPicker = useCallback(() => {
        setAgentPickerMemberId(null);
      }, []);
      const handleAgentSelect = useCallback(
        (selection: AgentSelection) => {
          if (!agentPickerMemberId) return;
          const agentId = resolveAgentIdFromSelection(selection);
          if (!agentId) return;
          updateMemberOverride(agentPickerMemberId, (current) => ({
            ...current,
            agentId,
          }));
          handleCloseAgentPicker();
        },
        [agentPickerMemberId, handleCloseAgentPicker, updateMemberOverride]
      );

      const applyForFuture =
        advancedConfig.applyAgentOrgMemberOverridesForFuture !== false;
      const handleApplyForFutureChange = useCallback(
        (checked: boolean) => {
          onAdvancedConfigChange({
            ...advancedConfig,
            applyAgentOrgMemberOverridesForFuture: checked,
          });
        },
        [advancedConfig, onAdvancedConfigChange]
      );

      return (
        <div
          data-testid="session-creator-org-members-panel"
          className={`flex w-full flex-col gap-1 rounded-[12px] border border-solid border-border-2 ${SURFACE_TOKENS.surface} p-1 ${className}`}
        >
          {members.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-text-3">
              {t("creator.orgMembers.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {members.map((member) => {
                const resolvedAgent = resolveMemberAgent(
                  member.agentId,
                  allAgents,
                  cliAgents
                );
                const IconComponent = resolvedAgent.iconId
                  ? resolveAgentIcon(resolvedAgent.iconId)
                  : null;
                const agentPillIcon = IconComponent ? (
                  <AnyIcon
                    icon={IconComponent}
                    size={PILL_SM_ICON_SIZE}
                    className="text-text-1"
                  />
                ) : resolvedAgent.cliAgentType ? (
                  <ModelIcon
                    agentType={
                      resolvedAgent.cliAgentType as React.ComponentProps<
                        typeof ModelIcon
                      >["agentType"]
                    }
                    size={PILL_SM_ICON_SIZE}
                  />
                ) : null;

                const memberConfig = applyAgentRuntimeConfig(
                  advancedConfig,
                  member.runtimeConfig
                );
                const modelIconName =
                  memberConfig.listingModel || memberConfig.model || undefined;
                const modelIconAgent =
                  memberConfig.listingModelType ??
                  memberConfig.selectedSourceModelType;
                const hasModelSelection = Boolean(modelIconName);
                const modelLabel =
                  member.runtimeConfig?.listingModelDisplay ??
                  member.runtimeConfig?.model ??
                  globalModelLabel;
                const modelTitle =
                  member.runtimeConfig?.listingModelDisplay ??
                  member.runtimeConfig?.model ??
                  globalModelTitle;
                const modelAccountName =
                  member.runtimeConfig?.selectedSourceLabel ??
                  globalModelAccountName;

                return (
                  <li
                    key={member.id}
                    data-testid="session-creator-org-member-row"
                    data-member-id={member.id}
                    className="flex items-center justify-between gap-3 rounded-md px-3 py-1"
                  >
                    <span className="truncate text-[14px] font-medium text-text-1">
                      {member.name}
                    </span>

                    <div className="flex shrink-0 items-center gap-2">
                      <SelectorPill
                        icon={agentPillIcon}
                        label={resolvedAgent.label}
                        title={resolvedAgent.label}
                        className="h-[28px] max-w-[180px] shrink-0 text-[12px]"
                        ariaLabel={t("creator.orgMembers.selectAgent")}
                        dataTestId="session-creator-org-member-agent-pill"
                        onClick={() => setAgentPickerMemberId(member.id)}
                      />

                      <SelectorPill
                        icon={
                          hasModelSelection ? (
                            <ModelIcon
                              modelName={modelIconName}
                              agentType={modelIconAgent}
                              size={PILL_SM_ICON_SIZE}
                            />
                          ) : (
                            <HugeiconsIcon
                              icon={AiSettingIcon}
                              data-icon="ai-setting"
                              size={PILL_SM_ICON_SIZE}
                              strokeWidth={1.75}
                              className="text-primary-6"
                            />
                          )
                        }
                        label={modelLabel}
                        tooltip={
                          <ModelSelectionBreadcrumb
                            accountName={modelAccountName}
                            modelLabel={modelTitle}
                            modelId={modelIconName}
                            modelType={modelIconAgent}
                          />
                        }
                        tooltipFramed
                        danger={!hasModelSelection}
                        active={modelPickerMemberId === member.id}
                        className="h-[28px] max-w-[220px] shrink-0 text-[12px]"
                        onClick={() => setModelPickerMemberId(member.id)}
                        ariaLabel={t("creator.selectModel")}
                        dataTestId="session-creator-org-member-model-pill"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div
            className="mt-1 flex items-center justify-end gap-2 border-t border-border-2 px-2 pb-1 pt-2"
            data-testid="session-creator-org-members-apply-future-row"
          >
            <span className="text-[12px] text-text-3">
              {t("creator.orgMembers.applyForFutureLabel")}
            </span>
            <Switch
              checked={applyForFuture}
              onCheckedChange={handleApplyForFutureChange}
              size="small"
              ariaLabel={t("creator.orgMembers.applyForFutureLabel")}
              dataTestId="session-creator-org-members-apply-future-switch"
            />
          </div>

          <DispatchCategoryPalette
            isOpen={isAgentPickerOpen}
            onClose={handleCloseAgentPicker}
            hideOrgs
            hideCliAgents
            titleLabel={agentPickerMember?.name}
            titleIcon={UserMultipleIcon}
            placeholderLabel={
              agentPickerMember
                ? t("creator.orgMembers.selectBaseAgentForRole", {
                    role: agentPickerMember.name,
                  })
                : undefined
            }
            currentAgentDefinitionId={
              agentPickerMember?.agentId.startsWith(CLI_AGENT_PREFIX)
                ? undefined
                : agentPickerMember?.agentId
            }
            currentCliAgentType={
              agentPickerMember?.agentId.startsWith(CLI_AGENT_PREFIX)
                ? (agentPickerMember.agentId.slice(
                    CLI_AGENT_PREFIX.length
                  ) as CliAgentType)
                : undefined
            }
            onSelect={handleAgentSelect}
          />

          {modelPickerMember && modelPickerDispatch && (
            <UnifiedModelPalette
              isOpen={Boolean(modelPickerMember)}
              onClose={() => setModelPickerMemberId(null)}
              advancedConfig={modelPickerConfig}
              onConfigChange={handleModelConfigChange}
              dispatchCategoryOverride={modelPickerDispatch.dispatchCategory}
              cliAgentTypeOverride={modelPickerDispatch.cliAgentType}
            />
          )}
        </div>
      );
    }
  );

SessionCreatorOrgMembersPanel.displayName = "SessionCreatorOrgMembersPanel";

export default SessionCreatorOrgMembersPanel;
