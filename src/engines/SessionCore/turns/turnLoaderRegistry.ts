import {
  isCodexAppSession,
  isCursorIdeSession,
  isExternalHistorySession,
} from "@src/util/session/sessionDispatch";

import { codexAppTurnLoader } from "./codexAppTurnLoader";
import { cursorIdeTurnLoader } from "./cursorIdeTurnLoader";
import { importedHistoryTurnLoader } from "./importedHistoryTurnLoader";
import {
  captureLoadedTurnRegistryGeneration,
  getPendingTurnLoad,
  markTurnBodyLoaded,
  trackPendingTurnLoad,
} from "./loadedTurnRegistry";
import { ownDbTurnLoader } from "./ownDbTurnLoader";
import type { LoadTurnBodyIntoStoreArgs, SessionTurnLoader } from "./types";

export function getSessionTurnLoader(sessionId: string): SessionTurnLoader {
  if (isCursorIdeSession(sessionId)) {
    return cursorIdeTurnLoader;
  }
  if (isCodexAppSession(sessionId)) {
    return codexAppTurnLoader;
  }
  if (isExternalHistorySession(sessionId)) {
    return importedHistoryTurnLoader;
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
  const generation = captureLoadedTurnRegistryGeneration(args.sessionId);
  const load = loader.loadTurnBodyIntoStore(args).then((loaded) => {
    // A body that is not in the local store yet (cloud replay still
    // downloading behind a turn-index skeleton) must NOT be marked loaded:
    // the placeholder's retry affordances key off this registry.
    if (loaded) {
      markTurnBodyLoaded(args.sessionId, args.turnId, generation);
    }
  });
  await trackPendingTurnLoad(args.sessionId, args.turnId, load);
}
