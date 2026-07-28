import { useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ModelType } from "@src/api/tauri/rpc/schemas/validation";
import type { DispatchCategory } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { isRegionSanctioned } from "@src/config/providerRegions";
import type { ChatPanelRegionNotice } from "@src/engines/ChatPanel/types";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { useRegionCheck } from "@src/hooks/config";
import { useAgentCompatibility } from "@src/hooks/models/useAgentCompatibility";
import { useAgentDefinitions } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentDefinitions";
import type { OrgMember } from "@src/modules/MainApp/AgentOrgs/types";
import {
  SESSION_TARGET_KIND,
  type SessionTargetKind,
  sessionCreatorStateAtom,
} from "@src/store/session";
import { getBigThreeRegionModelTypeForSession } from "@src/util/session/regionAlertModel";

import { resolveSessionCreatorAgentHeroContent } from "./resolveSessionCreatorAgentHero";

interface UseChatPanelAgentPresentationOptions {
  advancedConfig: AdvancedConfig;
  agentIconId: string | null;
  agentName: string | null;
  cliAgentType: CliAgentType | null;
  dispatchCategory: DispatchCategory;
  isCliMode: boolean;
  isCursorIdeMode: boolean;
  isOSMode: boolean;
  isRustMode: boolean;
  onRegionNoticeChange?: (notice: ChatPanelRegionNotice | null) => void;
  orgs: OrgMember[];
  selectedAgentDefId: string | null;
  selectedAgentOrgId: string | null;
  targetKind: SessionTargetKind;
}

export function useChatPanelAgentPresentation({
  advancedConfig,
  agentIconId,
  agentName,
  cliAgentType,
  dispatchCategory,
  isCliMode,
  isCursorIdeMode,
  isOSMode,
  isRustMode,
  onRegionNoticeChange,
  orgs,
  selectedAgentDefId,
  selectedAgentOrgId,
  targetKind,
}: UseChatPanelAgentPresentationOptions) {
  const { t } = useTranslation("sessions");
  const { registry } = useAgentCompatibility();
  const { builtInAgents, agents: customAgents } = useAgentDefinitions();
  const setCreatorState = useSetAtom(sessionCreatorStateAtom);

  const allAgentDefinitions = useMemo(
    () => [...builtInAgents, ...customAgents],
    [builtInAgents, customAgents]
  );
  const selectedAgentDefinition = useMemo(
    () =>
      selectedAgentDefId
        ? allAgentDefinitions.find((agent) => agent.id === selectedAgentDefId)
        : undefined,
    [allAgentDefinitions, selectedAgentDefId]
  );
  const selectedOrg = useMemo(
    () =>
      targetKind === SESSION_TARGET_KIND.AGENT_ORG && selectedAgentOrgId
        ? orgs.find((org) => org.id === selectedAgentOrgId)
        : undefined,
    [targetKind, selectedAgentOrgId, orgs]
  );

  // Rehydrate display fields after the workstation remounts this creator.
  useEffect(() => {
    if (!selectedAgentDefId || !selectedAgentDefinition) return;
    setCreatorState((previous) => {
      if (previous.selectedAgentDefinitionId !== selectedAgentDefId) {
        return previous;
      }
      const nextAgentName = selectedAgentDefinition.name;
      const nextAgentIconId = selectedAgentDefinition.iconId ?? null;
      if (
        previous.agentName === nextAgentName &&
        previous.agentIconId === nextAgentIconId
      ) {
        return previous;
      }
      return {
        ...previous,
        agentName: nextAgentName,
        agentIconId: nextAgentIconId,
      };
    });
  }, [selectedAgentDefId, selectedAgentDefinition, setCreatorState]);

  const resolvedAgentName = selectedAgentDefinition?.name ?? agentName;
  const resolvedAgentIconId = selectedAgentDefinition?.iconId || agentIconId;
  const hasAgentSelected = Boolean(
    (isCliMode && cliAgentType) ||
    (targetKind === SESSION_TARGET_KIND.AGENT_ORG && selectedAgentOrgId) ||
    selectedAgentDefId ||
    resolvedAgentName
  );
  const createAgentSelectorIcon = useCallback(
    (size: number) => {
      if (isCliMode && cliAgentType) {
        return <ModelIcon agentType={cliAgentType as ModelType} size={size} />;
      }
      if (isCursorIdeMode) {
        return <ModelIcon agentType="cursor_cli" size={size} />;
      }
      if (dispatchCategory === "human_session") {
        return React.createElement(
          resolveAgentIcon(resolvedAgentIconId || "clipboard-list"),
          {
            size,
            strokeWidth: 1.75,
            className: "text-text-1",
          }
        );
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
      isRustMode,
      isCliMode,
      isCursorIdeMode,
      dispatchCategory,
      cliAgentType,
      resolvedAgentIconId,
      hasAgentSelected,
    ]
  );
  const heroIcon = useMemo(
    () => createAgentSelectorIcon(20),
    [createAgentSelectorIcon]
  );
  const compactHeaderIcon = useMemo(
    () => createAgentSelectorIcon(14),
    [createAgentSelectorIcon]
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

  const regionModelType = useMemo(
    () =>
      getBigThreeRegionModelTypeForSession(
        dispatchCategory,
        advancedConfig,
        cliAgentType
      ),
    [dispatchCategory, advancedConfig, cliAgentType]
  );
  const regionCheck = useRegionCheck(regionModelType);
  const regionNotice = useMemo<ChatPanelRegionNotice | null>(() => {
    if (regionModelType === "" || regionCheck.status === "loading") return null;

    const sanctioned =
      regionCheck.countryCode && isRegionSanctioned(regionCheck.countryCode);
    const providerRestricted = regionCheck.status === "unsupported";
    if (!providerRestricted && !sanctioned) return null;

    const location = regionCheck.locationText || regionCheck.countryCode || "";
    const body = providerRestricted
      ? sanctioned
        ? t("creator.regionNoticeBodyBoth", { location })
        : t("creator.regionNoticeBodyProvider", { location })
      : t("creator.regionNoticeBodySanctions", { location });
    return {
      key: `${regionModelType}:${regionCheck.countryCode ?? "unknown"}:${regionCheck.status}`,
      title: t("creator.regionNoticeTitle"),
      body,
    };
  }, [
    regionModelType,
    regionCheck.status,
    regionCheck.countryCode,
    regionCheck.locationText,
    t,
  ]);

  useEffect(() => {
    onRegionNoticeChange?.(regionNotice);
    return () => onRegionNoticeChange?.(null);
  }, [onRegionNoticeChange, regionNotice]);

  return {
    allAgentDefinitions,
    compactHeaderIcon,
    heroContent,
    heroIcon,
    selectedOrg,
  };
}
