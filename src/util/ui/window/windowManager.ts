import { emit } from "@tauri-apps/api/event";

import { createLogger } from "@src/hooks/logger";

import { isTauriDesktop } from "../../platform/tauri";

const log = createLogger("WindowManager");

/**
 * Tell the main window to open a workspace after a session launch.
 *
 * Window creation used to live in this module as well. Detached tab, mode
 * selection, and workspace windows have been retired; this event bridge is
 * the only remaining cross-window responsibility.
 */
export const emitOpenWorkspace = async (
  sessionId: string,
  projectId: string,
  buildType?: string
): Promise<boolean> => {
  if (!isTauriDesktop()) {
    log.warn("Cannot emit event: Not in Tauri desktop environment");
    return false;
  }

  try {
    await emit("open-workspace", {
      sessionId,
      projectId,
      buildType,
    });
    return true;
  } catch (error) {
    log.error("Error sending open workspace message:", error);
    return false;
  }
};
