import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CliAgentType } from "@src/api/types/keys";
import { useCliVersions } from "@src/hooks/cliVersions/useCliVersions";
import { createLogger } from "@src/hooks/logger";
import { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import {
  CLI_LAUNCH_MODE,
  cliAgentVisibilityOverridesAtom,
  cliLaunchModeAtom,
  isCliAgentEnabled,
} from "@src/store/session";
import { creatorDefaultTuiModeAtom } from "@src/store/session/creatorDefaultTuiModeAtom";

const log = createLogger("ChatPanel");

interface UseCliAgentConfigurationOptions {
  cliAgentType: CliAgentType | null;
  isCliMode: boolean;
}

export function useCliAgentConfiguration({
  cliAgentType,
  isCliMode,
}: UseCliAgentConfigurationOptions) {
  const { agents: cliAgentList } = useCliAgents({ enabled: true });
  const cliVisibilityOverrides = useAtomValue(cliAgentVisibilityOverridesAtom);
  const enabledCliAgentList = useMemo(
    () =>
      cliAgentList.filter((agent) =>
        isCliAgentEnabled(agent.name, agent.installed, cliVisibilityOverrides)
      ),
    [cliAgentList, cliVisibilityOverrides]
  );
  const cliLaunchMode = useAtomValue(cliLaunchModeAtom);
  const setCliLaunchMode = useSetAtom(cliLaunchModeAtom);
  const defaultTuiMode = useAtomValue(creatorDefaultTuiModeAtom);
  const setDefaultTuiMode = useSetAtom(creatorDefaultTuiModeAtom);
  const { getVersion, scanVersion } = useCliVersions();
  const selectedCliVersion = cliAgentType
    ? getVersion(cliAgentType)
    : undefined;

  useEffect(() => {
    if (!isCliMode || !cliAgentType) return;
    void scanVersion(cliAgentType).catch((error) => {
      log.warn("CLI version scan failed", error);
    });
  }, [cliAgentType, isCliMode, scanVersion]);

  const selectedCliAgent = useMemo(
    () =>
      isCliMode && cliAgentType
        ? enabledCliAgentList.find((agent) => agent.name === cliAgentType)
        : undefined,
    [isCliMode, cliAgentType, enabledCliAgentList]
  );
  const selectedCliAgentSupportsGui = selectedCliAgent?.supportsGui === true;
  const selectedCliAgentGuiSupportKnown = Boolean(selectedCliAgent);
  const cliComposerEnabled =
    cliLaunchMode === CLI_LAUNCH_MODE.GUI &&
    (!selectedCliAgentGuiSupportKnown || selectedCliAgentSupportsGui);
  const cliVersionOutdatedAlertKey =
    isCliMode && cliAgentType && selectedCliVersion?.status === "outdated"
      ? `${cliAgentType}:${selectedCliVersion.installed_version ?? "unknown"}:${selectedCliVersion.latest_version ?? "unknown"}`
      : null;
  const [dismissedCliVersionAlertKey, setDismissedCliVersionAlertKey] =
    useState<string | null>(null);
  const [refreshingCliAgentType, setRefreshingCliAgentType] =
    useState<CliAgentType | null>(null);
  const showCliVersionOutdatedAlert = Boolean(
    cliVersionOutdatedAlertKey &&
    cliVersionOutdatedAlertKey !== dismissedCliVersionAlertKey
  );
  const refreshSelectedCliVersion = useCallback(async () => {
    if (!isCliMode || !cliAgentType) return;
    const requestedAgentType = cliAgentType;
    setRefreshingCliAgentType(requestedAgentType);
    try {
      await scanVersion(requestedAgentType, true);
    } catch (error) {
      log.warn("CLI version refresh failed", error);
    } finally {
      setRefreshingCliAgentType((currentAgentType) =>
        currentAgentType === requestedAgentType ? null : currentAgentType
      );
    }
  }, [cliAgentType, isCliMode, scanVersion]);

  const setAgentSelectionLaunchMode = useCallback(
    (mode: typeof cliLaunchMode) => {
      setCliLaunchMode(mode);
      setDefaultTuiMode(mode === CLI_LAUNCH_MODE.TUI);
    },
    [setCliLaunchMode, setDefaultTuiMode]
  );

  const handleCliLaunchModeChange = useCallback(
    (mode: typeof cliLaunchMode) => {
      if (mode === CLI_LAUNCH_MODE.GUI && !selectedCliAgentSupportsGui) return;
      setAgentSelectionLaunchMode(mode);
    },
    [selectedCliAgentSupportsGui, setAgentSelectionLaunchMode]
  );

  return {
    cliComposerEnabled,
    cliLaunchMode,
    defaultTuiMode,
    enabledCliAgentList,
    handleCliLaunchModeChange,
    selectedCliAgent,
    selectedCliAgentGuiSupportKnown,
    selectedCliAgentSupportsGui,
    selectedCliVersion,
    isSelectedCliVersionRefreshing: refreshingCliAgentType === cliAgentType,
    refreshSelectedCliVersion,
    setAgentSelectionLaunchMode,
    setDismissedCliVersionAlertKey,
    showCliVersionOutdatedAlert,
    cliVersionOutdatedAlertKey,
  };
}
