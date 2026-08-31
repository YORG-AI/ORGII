import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CliAgentType } from "@src/api/types/keys";
import { useCliVersions } from "@src/hooks/cliVersions/useCliVersions";
import { createLogger } from "@src/hooks/logger";
import { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import {
  CLI_LAUNCH_MODE,
  CLI_UPDATE_ALERT_SNOOZE_MS,
  cliAgentVisibilityOverridesAtom,
  cliLaunchModeAtom,
  cliUpdateAlertSuppressionsAtom,
  cliUpdateAlertsEnabledAtom,
  isCliAgentEnabled,
  isCliUpdateAlertSuppressed,
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
  const cliUpdateAlertsEnabled = useAtomValue(cliUpdateAlertsEnabledAtom);
  const [cliUpdateAlertSuppressions, setCliUpdateAlertSuppressions] = useAtom(
    cliUpdateAlertSuppressionsAtom
  );
  const {
    getVersion,
    isVersionRecheckPending,
    scanVersion,
    subscribeVersionRecheck,
  } = useCliVersions();
  const selectedCliVersion = cliAgentType
    ? getVersion(cliAgentType)
    : undefined;

  useEffect(() => {
    if (!cliUpdateAlertsEnabled || !isCliMode || !cliAgentType) return;
    void scanVersion(cliAgentType).catch((error) => {
      log.warn("CLI version scan failed", error);
    });
  }, [cliAgentType, cliUpdateAlertsEnabled, isCliMode, scanVersion]);

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
  const isSelectedCliVersionOutdated =
    isCliMode &&
    Boolean(cliAgentType) &&
    selectedCliVersion?.status === "outdated";
  const [refreshingCliAgentType, setRefreshingCliAgentType] =
    useState<CliAgentType | null>(null);
  const selectedCliUpdateAlertSuppression = cliAgentType
    ? cliUpdateAlertSuppressions[cliAgentType]
    : undefined;
  const selectedCliUpdateAlertSnoozedUntil =
    selectedCliUpdateAlertSuppression?.snoozedUntil;

  useEffect(() => {
    if (
      !cliUpdateAlertsEnabled ||
      !isCliMode ||
      !cliAgentType ||
      !selectedCliUpdateAlertSnoozedUntil
    ) {
      return;
    }

    return subscribeVersionRecheck(
      cliAgentType,
      selectedCliUpdateAlertSnoozedUntil
    );
  }, [
    cliAgentType,
    cliUpdateAlertsEnabled,
    isCliMode,
    selectedCliUpdateAlertSnoozedUntil,
    subscribeVersionRecheck,
  ]);

  const isSelectedCliVersionRecheckPending = Boolean(
    cliAgentType &&
    selectedCliUpdateAlertSnoozedUntil &&
    isVersionRecheckPending(cliAgentType, selectedCliUpdateAlertSnoozedUntil)
  );

  const showCliVersionOutdatedAlert = Boolean(
    cliUpdateAlertsEnabled &&
    isSelectedCliVersionOutdated &&
    !isSelectedCliVersionRecheckPending &&
    !isCliUpdateAlertSuppressed(
      selectedCliUpdateAlertSuppression,
      selectedCliVersion?.latest_version,
      Date.now()
    )
  );
  const refreshSelectedCliVersion = useCallback(async () => {
    if (!cliUpdateAlertsEnabled || !isCliMode || !cliAgentType) return;
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
  }, [cliAgentType, cliUpdateAlertsEnabled, isCliMode, scanVersion]);

  const snoozeSelectedCliVersionAlert = useCallback(() => {
    if (!cliAgentType) return;
    const requestedAgentType = cliAgentType;
    const snoozedUntil = Date.now() + CLI_UPDATE_ALERT_SNOOZE_MS;
    setCliUpdateAlertSuppressions((currentSuppressions) => ({
      ...currentSuppressions,
      [requestedAgentType]: {
        ...currentSuppressions[requestedAgentType],
        snoozedUntil,
      },
    }));
  }, [cliAgentType, setCliUpdateAlertSuppressions]);

  const muteSelectedCliVersionAlertUntilNextVersion = useCallback(() => {
    const latestVersion = selectedCliVersion?.latest_version;
    if (!cliAgentType || !latestVersion) return;
    const requestedAgentType = cliAgentType;
    setCliUpdateAlertSuppressions((currentSuppressions) => ({
      ...currentSuppressions,
      [requestedAgentType]: {
        ...currentSuppressions[requestedAgentType],
        mutedLatestVersion: latestVersion,
      },
    }));
  }, [
    cliAgentType,
    selectedCliVersion?.latest_version,
    setCliUpdateAlertSuppressions,
  ]);

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
    snoozeSelectedCliVersionAlert,
    muteSelectedCliVersionAlertUntilNextVersion,
    showCliVersionOutdatedAlert,
  };
}
