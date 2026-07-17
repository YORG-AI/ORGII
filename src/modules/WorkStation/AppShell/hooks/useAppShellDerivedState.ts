import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import {
  type StatusBarAppType,
  activeStatusBarAppAtom,
} from "@src/store/ui/workStationAtom";
import { activeHostAtom } from "@src/store/workstation";
import type { WorkstationTabHost } from "@src/store/workstation/tabHost";

export interface AppShellDerivedState {
  activeHost: WorkstationTabHost;
  isCodeMode: boolean;
  isBrowserMode: boolean;
  isProjectMode: boolean;
  codeContentVisible: boolean;
  browserContentVisible: boolean;
  projectContentVisible: boolean;
}

export function useAppShellDerivedState(): AppShellDerivedState {
  // Unified surface: the content host simply follows the active tab's host.
  // Browser sessions live in `mainPane` (as `browser-session` tabs), so a
  // browser tab makes `activeHost` "browser" on its own — no host pin needed,
  // and closing the last tab lands back on the Launchpad instead of a
  // stranded empty host.
  const activeHost = useAtomValue(activeHostAtom);

  const isCodeMode = activeHost === "code";
  const isBrowserMode = activeHost === "browser";
  const isProjectMode = activeHost === "project";

  const codeContentVisible = isCodeMode;
  const browserContentVisible = isBrowserMode;
  const projectContentVisible = isProjectMode;

  const setActiveStatusBarApp = useSetAtom(activeStatusBarAppAtom);
  useEffect(() => {
    let appType: StatusBarAppType;
    if (activeHost === "browser") {
      appType = "browser";
    } else if (activeHost === "project") {
      appType = "project";
    } else {
      appType = "code";
    }
    setActiveStatusBarApp(appType);
  }, [activeHost, setActiveStatusBarApp]);

  return {
    activeHost,
    isCodeMode,
    isBrowserMode,
    isProjectMode,
    codeContentVisible,
    browserContentVisible,
    projectContentVisible,
  };
}
