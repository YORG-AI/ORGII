import { useEffect } from "react";

import { loadSidebarSessions } from "@src/store/session";

import {
  SIDEBAR_SESSION_ACTIVE_REFRESH_INTERVAL_MS,
  SIDEBAR_SESSION_IDLE_REFRESH_INTERVAL_MS,
} from "../sidebarConnectorUtils";

export function useSidebarSessionRefreshEffects(): void {
  useEffect(() => {
    void loadSidebarSessions({ forceRefresh: true });
  }, []);


  useEffect(() => {
    let sidebarIntervalId: number | null = null;

    const getSidebarRefreshInterval = () =>
      document.hasFocus()
        ? SIDEBAR_SESSION_ACTIVE_REFRESH_INTERVAL_MS
        : SIDEBAR_SESSION_IDLE_REFRESH_INTERVAL_MS;

    const refreshAllSidebarSessions = () => {
      if (document.visibilityState !== "visible") return;
      void loadSidebarSessions({ forceRefresh: true });
    };

    const scheduleRefresh = () => {
      if (sidebarIntervalId !== null) {
        window.clearInterval(sidebarIntervalId);
        sidebarIntervalId = null;
      }
      if (document.visibilityState !== "visible") return;
      sidebarIntervalId = window.setInterval(
        refreshAllSidebarSessions,
        getSidebarRefreshInterval()
      );
    };

    const handleActivityStateChange = () => {
      refreshAllSidebarSessions();
      scheduleRefresh();
    };

    scheduleRefresh();
    document.addEventListener("visibilitychange", handleActivityStateChange);
    window.addEventListener("focus", handleActivityStateChange);
    window.addEventListener("blur", scheduleRefresh);
    return () => {
      if (sidebarIntervalId !== null) window.clearInterval(sidebarIntervalId);
      document.removeEventListener(
        "visibilitychange",
        handleActivityStateChange
      );
      window.removeEventListener("focus", handleActivityStateChange);
      window.removeEventListener("blur", scheduleRefresh);
    };
  }, []);
}
