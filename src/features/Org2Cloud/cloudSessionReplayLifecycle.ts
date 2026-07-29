import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

type CloudSessionReplayIconInput = Partial<
  Pick<
    RemoteTeammateSessionMetadata,
    | "sourceSessionId"
    | "cliAgentType"
    | "agentDisplayName"
    | "agentDefinitionId"
    | "model"
    | "origin"
  >
>;

/**
 * Icon identity already visible on the source row before local hydration.
 * Delegates to the canonical row projection so the placeholder shown while a
 * replay imports is the exact mark the Team Sessions row carries — including
 * the legacy `*_cli` wire aliases, which resolve to no registered icon on
 * their own.
 */
export function resolveCloudSessionReplayIconId(
  session: CloudSessionReplayIconInput
): string {
  return resolveSessionDisplayMetadata({
    kind: "remote",
    session: { ...session, sourceSessionId: session.sourceSessionId ?? "" },
  }).agentIconId;
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
