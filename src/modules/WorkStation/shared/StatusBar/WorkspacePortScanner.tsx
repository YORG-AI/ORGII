/**
 * Low-CPU background poller for workspace listening ports.
 * Mount only while the code editor host is active.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import {
  WORKSPACE_PORT_SCAN_INTERVAL_MS,
  workspacePortProbesAtom,
  workspacePortsStateAtom,
} from "@src/store/workstation/codeEditor/workspacePortsAtom";

import {
  refreshWorkspacePortScan,
  subscribeWorkspacePortScan,
} from "./utils/workspacePortActions";

interface WorkspacePortScannerProps {
  enabled: boolean;
}

export function WorkspacePortScanner({
  enabled,
}: WorkspacePortScannerProps): null {
  const folders = useAtomValue(workspacePortProbesAtom);
  const setState = useSetAtom(workspacePortsStateAtom);

  useEffect(() => {
    return subscribeWorkspacePortScan((update) => {
      setState((previous) => ({
        result: update.result ?? previous.result,
        refreshing: update.refreshing,
        lastScanStartedAt:
          update.lastScanStartedAt ?? previous.lastScanStartedAt,
      }));
    });
  }, [setState]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    const runScan = (force = false) => {
      if (cancelled || document.visibilityState !== "visible") {
        return;
      }
      void refreshWorkspacePortScan({ folders, force });
    };

    const clearPollInterval = () => {
      if (intervalId != null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const startPollInterval = () => {
      clearPollInterval();
      intervalId = window.setInterval(() => {
        runScan(false);
      }, WORKSPACE_PORT_SCAN_INTERVAL_MS);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        runScan(false);
        startPollInterval();
      } else {
        clearPollInterval();
      }
    };

    if (document.visibilityState === "visible") {
      runScan(true);
      startPollInterval();
    }

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      clearPollInterval();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, folders]);

  return null;
}
