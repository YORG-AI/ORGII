/**
 * Mirror workspace port scan notifications into jotai state.
 *
 * Every surface that can trigger a scan needs this mounted, otherwise the
 * scan runs and its result is dropped on the floor: the background scanner
 * only runs while a code-host tab is visible, but the ports status menu (and
 * its rescan action) is reachable from every status-bar host.
 */
import { useSetAtom } from "jotai";
import { useEffect } from "react";

import { workspacePortsStateAtom } from "@src/store/workstation/codeEditor/workspacePortsAtom";

import { subscribeWorkspacePortScan } from "./utils/workspacePortActions";
import { applyWorkspacePortScanUpdate } from "./utils/workspacePortScanState";

export function useWorkspacePortScanSync(): void {
  const setState = useSetAtom(workspacePortsStateAtom);

  useEffect(() => {
    return subscribeWorkspacePortScan((update) => {
      setState((previous) => applyWorkspacePortScanUpdate(previous, update));
    });
  }, [setState]);
}
