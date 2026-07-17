/**
 * Low-CPU background poller for workspace listening ports.
 * Mount only while the code editor host is active.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";

import { useVisiblePolling } from "@src/hooks/async";
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

  const runScan = useCallback(async () => {
    await refreshWorkspacePortScan({ folders });
  }, [folders]);

  useVisiblePolling({
    enabled,
    intervalMs: WORKSPACE_PORT_SCAN_INTERVAL_MS,
    poll: runScan,
  });

  return null;
}
