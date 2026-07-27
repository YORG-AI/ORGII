import {
  isCodexAppSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

import { codexAppTurnLoader } from "./codexAppTurnLoader";
import { cursorIdeTurnLoader } from "./cursorIdeTurnLoader";
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
  const load = loader.loadTurnBodyIntoStore(args).then(() => {
    markTurnBodyLoaded(args.sessionId, args.turnId, generation);
  });
  await trackPendingTurnLoad(args.sessionId, args.turnId, load);
}
