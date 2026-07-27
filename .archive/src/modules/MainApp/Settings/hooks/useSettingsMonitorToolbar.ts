import type { TFunction } from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import Message from "@src/components/Message";
import {
  REFRESH_COOLDOWN_MS,
  monitorRefreshTriggerAtom,
  monitorScanningAtom,
} from "@src/store/ui/settingsPanelAtoms";
import { settingsToolbarAtom } from "@src/store/ui/settingsToolbarAtom";

import { SECTION_IDS } from "../config";

export function useSettingsMonitorToolbar(
  activeSection: string,
  t: TFunction<"settings">
): void {
  const lastRefreshTimeRef = useRef(0);
  const setMonitorTrigger = useSetAtom(monitorRefreshTriggerAtom);
  const isMonitorScanning = useAtomValue(monitorScanningAtom);
  const setToolbarEntry = useSetAtom(settingsToolbarAtom);
  const showMonitorRefresh = activeSection === SECTION_IDS.MONITOR;

  const handleMonitorRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastRefreshTimeRef.current < REFRESH_COOLDOWN_MS) {
      Message.info(t("common:refreshToast.cooldown"));
      return;
    }
    lastRefreshTimeRef.current = now;
    setMonitorTrigger((current) => current + 1);
  }, [setMonitorTrigger, t]);

  useEffect(() => {
    setToolbarEntry((current) => ({
      ...current,
      onRefresh: showMonitorRefresh ? handleMonitorRefresh : undefined,
      loading: showMonitorRefresh ? isMonitorScanning : undefined,
    }));
  }, [
    handleMonitorRefresh,
    isMonitorScanning,
    setToolbarEntry,
    showMonitorRefresh,
  ]);
}
