import { useCallback } from "react";

import { SessionService } from "@src/engines/SessionCore/services";
import { createLogger } from "@src/hooks/logger";
import { useTauriListen } from "@src/hooks/platform/useTauriListen";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

const logger = createLogger("MobileRemoteDesktopActions");

interface MobileOpenSessionFilePayload {
  sessionId: string;
  filePath: string;
  line?: number;
}

function isOpenSessionFilePayload(
  value: unknown
): value is MobileOpenSessionFilePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.sessionId === "string" &&
    payload.sessionId.length > 0 &&
    typeof payload.filePath === "string" &&
    payload.filePath.length > 0 &&
    (payload.line == null ||
      (typeof payload.line === "number" &&
        Number.isInteger(payload.line) &&
        payload.line >= 1))
  );
}

/** Own the single Desktop listener for authenticated Mobile Remote actions. */
export function useMobileRemoteDesktopActions(): void {
  const handleOpenSessionFile = useCallback((payload: unknown) => {
    if (!isOpenSessionFilePayload(payload)) {
      logger.warn("Ignored invalid mobile file-open payload");
      return;
    }
    void SessionService.open({ sessionId: payload.sessionId })
      .then(() => {
        openFileInWorkStation(payload.filePath, { line: payload.line });
      })
      .catch((error: unknown) => {
        logger.warn("Failed to open Mobile Remote file in Desktop", error);
      });
  }, []);

  useTauriListen("mobile-open-session-file", handleOpenSessionFile);
}
