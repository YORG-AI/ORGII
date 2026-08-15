import {
  DispatchCategoryDropdown,
  DispatchCategoryPalette,
} from "@/src/scaffold/GlobalSpotlight/palettes";
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import { CLI_AGENT, type ModelType } from "@src/api/types/keys";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { useAdvancedConfig } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useAdvancedConfig";
import ControlButtons from "@src/features/SessionCreator/components/ControlButtons";
import SessionCreatorAgentHero from "@src/features/SessionCreator/variants/ChatPanel/SessionCreatorAgentHero";
import { resolveSessionCreatorAgentHeroContent } from "@src/features/SessionCreator/variants/ChatPanel/resolveSessionCreatorAgentHero";
import { useAgentCompatibility } from "@src/hooks/models/useAgentCompatibility";
import { useAgentDefinitions } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentDefinitions";
import { useAgentOrgs } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentOrgs";
import { PANEL_FOOTER_TOKENS } from "@src/modules/shared/layouts/blocks";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes";
import {
  SESSION_TARGET_KIND,
  agentIconIdAtom,
  agentNameAtom,
  cliAgentTypeAtom,
  dispatchCategoryAtom,
  selectedAgentDefinitionIdAtom,
  selectedAgentOrgIdAtom,
  sessionCreatorStateAtom,
  sessionTargetKindAtom,
} from "@src/store/session";
import { modelPickerStyleAtom } from "@src/store/ui/chatPanelAtom";
import { getRustAgentType } from "@src/util/session/sessionDispatch";

interface BenchmarkRunBuilderProps {
  bodySlot?: React.ReactNode;
  className: string;
  footerSlot?: React.ReactNode;
}

export function BenchmarkRunBuilder({
  bodySlot,
  className,
  footerSlot,
}: BenchmarkRunBuilderProps): React.ReactNode {
  const { t } = useTranslation("sessions");
  const { registry } = useAgentCompatibility();
  const { builtInAgents, agents: customAgents } = useAgentDefinitions();
  const { orgs } = useAgentOrgs();
  const { advancedConfig, setAdvancedConfig } = useAdvancedConfig();

  const setCreatorState = useSetAtom(sessionCreatorStateAtom);
  const dispatchCategory = useAtomValue(dispatchCategoryAtom);
  const targetKind = useAtomValue(sessionTargetKindAtom);
  const selectedAgentDefinitionId = useAtomValue(selectedAgentDefinitionIdAtom);
  const selectedAgentOrgId = useAtomValue(selectedAgentOrgIdAtom);
  const agentName = useAtomValue(agentNameAtom);
  const agentIconId = useAtomValue(agentIconIdAtom);
  const cliAgentType = useAtomValue(cliAgentTypeAtom);
  const modelPickerStyle = useAtomValue(modelPickerStyleAtom);

  const [isCategorySelectorOpen, setIsCategorySelectorOpen] = useState(false);
  const [requestModelOpen, setRequestModelOpen] = useState(false);
  const agentHeroRef = useRef<HTMLButtonElement>(null);

  const selectedAgentDefinition = useMemo(
    () =>
      selectedAgentDefinitionId
        ? [...builtInAgents, ...customAgents].find(
            (agent) => agent.id === selectedAgentDefinitionId
          )
        : undefined,
    [builtInAgents, customAgents, selectedAgentDefinitionId]
  );

  const agentVariant = getRustAgentType(selectedAgentDefinitionId);
  const isRustMode = dispatchCategory === DISPATCH_CATEGORY.RUST_AGENT;
  const isOSMode = isRustMode && agentVariant === "os";
  const isCliMode = dispatchCategory === DISPATCH_CATEGORY.CLI_AGENT;
  const isCursorIdeMode = dispatchCategory === DISPATCH_CATEGORY.CURSOR_IDE;
  const resolvedAgentName = selectedAgentDefinition?.name ?? agentName;
  const resolvedAgentIconId = selectedAgentDefinition?.iconId || agentIconId;
  const hasAgentSelected = Boolean(
    (isCliMode && cliAgentType) ||
    (targetKind === SESSION_TARGET_KIND.AGENT_ORG && selectedAgentOrgId) ||
    selectedAgentDefinitionId ||
    resolvedAgentName
  );

  const createAgentSelectorIcon = useCallback(
    (size: number) => {
      if (isCliMode && cliAgentType) {
        return <ModelIcon agentType={cliAgentType as ModelType} size={size} />;
      }
      if (isCursorIdeMode) {
        return <ModelIcon agentType={CLI_AGENT.CURSOR} size={size} />;
      }
      if (isRustMode) {
        const iconId = resolvedAgentIconId || "code";
        return React.createElement(resolveAgentIcon(iconId), {
          size,
          strokeWidth: 1.75,
          className: hasAgentSelected ? "text-text-1" : "text-primary-6",
        });
      }
      return null;
    },
    [
      isCliMode,
      isCursorIdeMode,
      isRustMode,
      cliAgentType,
      resolvedAgentIconId,
      hasAgentSelected,
    ]
  );

  const heroContent = useMemo(
    () =>
      resolveSessionCreatorAgentHeroContent({
        hasAgentSelected,
        dispatchCategory,
        targetKind,
        selectedAgentDefinition,
        resolvedAgentName,
        cliAgentType,
        selectedAgentOrgId,
        orgs,
        agentRegistry: registry,
        isOSMode,
      }),
    [
      hasAgentSelected,
      dispatchCategory,
      targetKind,
      selectedAgentDefinition,
      resolvedAgentName,
      cliAgentType,
      selectedAgentOrgId,
      orgs,
      registry,
      isOSMode,
    ]
  );

  const handleCategorySelect = useCallback(
    (selection: AgentSelection) => {
      setCreatorState((previous) => ({
        ...previous,
        dispatchCategory: selection.category,
        targetKind: selection.targetKind,
        selectedAgentDefinitionId: selection.agentDefinitionId ?? null,
        selectedAgentOrgId: selection.agentOrgId ?? null,
        agentName: selection.agentName,
        agentIconId: selection.agentIconId ?? null,
        cliAgentType: selection.cliAgentType ?? null,
      }));

      if (selection.cliAgentType) {
        setAdvancedConfig((previous) => ({
          ...previous,
          cliAgentType: selection.cliAgentType,
        }));
      }
      setRequestModelOpen(true);
    },
    [setAdvancedConfig, setCreatorState]
  );

  return (
    <div className={`flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="scrollbar-overlay flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-6">
        <div
          className={`flex w-full flex-col items-stretch gap-3 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
        >
          <SessionCreatorAgentHero
            ref={agentHeroRef}
            name={heroContent.name}
            description={heroContent.description}
            avatarIcon={createAgentSelectorIcon(20)}
            active={isCategorySelectorOpen}
            danger={heroContent.danger}
            onClick={() => setIsCategorySelectorOpen(true)}
          />

          <div className="bg-fill-0 flex min-h-10 items-center justify-between rounded-[12px] border border-solid border-border-2 px-3 py-2">
            <div className="min-w-0 text-[13px] font-medium text-text-1">
              {t("creator.model")}
            </div>
            <ControlButtons
              advancedConfig={advancedConfig}
              onConfigChange={setAdvancedConfig}
              dropdownDirection="down"
              requestModelOpen={requestModelOpen}
              onModelOpenHandled={() => setRequestModelOpen(false)}
              hideModePill
            />
          </div>

          {bodySlot}
        </div>
      </div>

      {footerSlot ? (
        <div className={`${PANEL_FOOTER_TOKENS.container} justify-end`}>
          {footerSlot}
        </div>
      ) : null}

      {modelPickerStyle === "dropdown" ? (
        <DispatchCategoryDropdown
          isOpen={isCategorySelectorOpen}
          onClose={() => setIsCategorySelectorOpen(false)}
          onSelect={handleCategorySelect}
          currentCategory={dispatchCategory}
          currentAgentDefinitionId={selectedAgentDefinitionId ?? undefined}
          currentAgentOrgId={selectedAgentOrgId ?? undefined}
          currentCliAgentType={cliAgentType ?? undefined}
          anchorRef={agentHeroRef}
        />
      ) : (
        <DispatchCategoryPalette
          isOpen={isCategorySelectorOpen}
          onClose={() => setIsCategorySelectorOpen(false)}
          onSelect={handleCategorySelect}
          currentCategory={dispatchCategory}
          currentAgentDefinitionId={selectedAgentDefinitionId ?? undefined}
          currentAgentOrgId={selectedAgentOrgId ?? undefined}
          currentCliAgentType={cliAgentType ?? undefined}
        />
      )}
    </div>
  );
}
