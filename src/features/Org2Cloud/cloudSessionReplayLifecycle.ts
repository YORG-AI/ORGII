import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

/** Icon identity already visible on the source row before local hydration. */
export function resolveCloudSessionReplayIconId(
  session: Pick<RemoteTeammateSessionMetadata, "origin" | "cliAgentType">
): string {
  if (session.origin?.kind === "external_history") {
    const sourceId = session.origin.source;
    const descriptor = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
      (source) => source.sourceId === sourceId
    );
    if (descriptor) return descriptor.iconId;
  }
  return session.cliAgentType || "orgii";
}

/**
 * Open a Chat Pane session surface synchronously before awaiting its remote
 * transcript. The matching hydration marker is always released, including
 * cancellation and failure paths.
 */
export async function runImmediateCloudSessionReplay<T>({
  sessionId,
  beginHydration,
  openTab,
  load,
  endHydration,
}: {
  sessionId: string;
  beginHydration: (sessionId: string) => void;
  openTab: (sessionId: string) => void;
  load: () => Promise<T>;
  endHydration: (sessionId: string) => void;
}): Promise<T> {
  beginHydration(sessionId);
  openTab(sessionId);
  try {
    return await load();
  } finally {
    endHydration(sessionId);
  }
}
