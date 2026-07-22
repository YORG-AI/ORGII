import { resolveExternalReplayTarget } from "@src/api/tauri/externalHistory/replay";

import { externalReplayTurnLoader } from "./externalReplayTurnLoader";
import {
  getPendingTurnLoad,
  markTurnBodyLoaded,
  trackPendingTurnLoad,
} from "./loadedTurnRegistry";
import { ownDbTurnLoader } from "./ownDbTurnLoader";
import type { LoadTurnBodyIntoStoreArgs, SessionTurnLoader } from "./types";

export function getSessionTurnLoader(sessionId: string): SessionTurnLoader {
  if (resolveExternalReplayTarget(sessionId)) {
    return externalReplayTurnLoader;
  }
  return ownDbTurnLoader;
}

export async function loadSessionTurnBodyIntoStore(
  args: LoadTurnBodyIntoStoreArgs
): Promise<void> {
  const pendingLoad = getPendingTurnLoad(args.sessionId, args.turnId);
  if (pendingLoad) {
    await pendingLoad;
    return;
  }

  const loader = getSessionTurnLoader(args.sessionId);
  const load = loader.loadTurnBodyIntoStore(args).then(() => {
    markTurnBodyLoaded(args.sessionId, args.turnId);
  });
  await trackPendingTurnLoad(args.sessionId, args.turnId, load);
}
