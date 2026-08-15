import { atom } from "jotai";

import { clearSessionAtom } from "@src/engines/SessionCore/core/atoms/actions";
import { invalidateSessionChatPanelTabsAtom } from "@src/store/chatPanel/chatPanelSessionInvalidationAtom";
import { removeAgentSessionTerminalAtom } from "@src/store/workstation/codeEditor/terminal";
import {
  disposeWorkstationWorkspaceAtom,
  removeSessionWorkstationTabsAtom,
} from "@src/store/workstation/tabs/atoms";

import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "./viewAtom";

/**
 * Invalidate every frontend projection of a deleted agent session in one
 * synchronous Jotai transaction. The backend/session list remains owned by
 * the caller that confirmed deletion.
 */
export const invalidateSessionPresentationAtom = atom(
  null,
  (get, set, sessionId: string) => {
    set(invalidateSessionChatPanelTabsAtom, sessionId);
    set(removeSessionWorkstationTabsAtom, sessionId);
    set(disposeWorkstationWorkspaceAtom, sessionId);
    set(removeAgentSessionTerminalAtom, sessionId);

    if (get(workstationActiveSessionIdAtom) === sessionId) {
      set(workstationActiveSessionIdAtom, null);
    }
    if (get(activeSessionIdAtom) === sessionId) {
      set(clearSessionAtom);
      set(activeSessionIdAtom, null);
    }
  }
);
invalidateSessionPresentationAtom.debugLabel =
  "invalidateSessionPresentationAtom";
