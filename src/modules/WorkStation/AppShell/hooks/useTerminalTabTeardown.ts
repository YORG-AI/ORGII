/**
 * useTerminalTabTeardown
 *
 * VS Code-style terminal lifecycle: closing the Terminal tab kills every
 * running PTY (dev servers, agents, shells). We watch the unified tab pool and,
 * when the terminal tab transitions from present to absent (any close path —
 * the pill's ✕, close-all, close-others), tear down all sessions. The store
 * keeps one fresh default, so reopening the Terminal tab starts clean.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import { closeAllTerminalSessionsAtom } from "@src/store/workstation/codeEditor/terminal";
import { mainPaneTabsAtom } from "@src/store/workstation/tabs";

export function useTerminalTabTeardown(): void {
  const tabs = useAtomValue(mainPaneTabsAtom);
  const closeAllTerminalSessions = useSetAtom(closeAllTerminalSessionsAtom);

  const hasTerminalTab = tabs.some((tab) => tab.type === "terminal");
  const prevHadTerminalTabRef = useRef(hasTerminalTab);

  useEffect(() => {
    const prevHad = prevHadTerminalTabRef.current;
    prevHadTerminalTabRef.current = hasTerminalTab;
    if (prevHad && !hasTerminalTab) {
      void closeAllTerminalSessions();
    }
  }, [hasTerminalTab, closeAllTerminalSessions]);
}
