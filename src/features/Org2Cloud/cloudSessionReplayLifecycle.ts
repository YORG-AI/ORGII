import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { basename } from "@src/util/path";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

import type {
  CloudPendingPlay,
  CloudSessionEnvironmentIdentity,
} from "./cloudSessionDownloadControlAtoms";

type CloudSessionReplayIconInput = Partial<
  Pick<
    RemoteTeammateSessionMetadata,
    | "sourceSessionId"
    | "cliAgentType"
    | "agentDisplayName"
    | "agentDefinitionId"
    | "model"
    | "origin"
    | "repoPath"
    | "repoScopeKey"
    | "branch"
    | "baseBranch"
    | "worktreeBranch"
  >
>;

export function resolveCloudSessionEnvironmentIdentity(
  session: CloudSessionReplayIconInput
): CloudSessionEnvironmentIdentity {
  const repoIdentity = session.repoScopeKey || session.repoPath;
  const rawRepoName = repoIdentity ? basename(repoIdentity) : undefined;
  return {
    repoName: rawRepoName?.replace(/\.git$/, "") || undefined,
    branchName: session.branch || session.baseBranch || undefined,
    baseBranchName: session.baseBranch || undefined,
    worktreeBranchName: session.worktreeBranch || undefined,
  };
}

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
 * Preserve the remote row's display identity while a large transcript is
 * parked before download. No local Session exists yet, so every pre-download
 * surface must project from this entry instead of falling back to ORGII.
 */
export function buildCloudPendingPlayEntry({
  remoteSession,
  orgId,
  pendingEvents,
  etaMs,
  kind,
}: {
  remoteSession: CloudSessionReplayIconInput & { id: string };
  orgId: string;
  pendingEvents: number;
  etaMs: number;
  kind: CloudPendingPlay["kind"];
}): CloudPendingPlay {
  return {
    rowId: remoteSession.id,
    orgId,
    iconId: resolveCloudSessionReplayIconId(remoteSession),
    sessionEnvironment: resolveCloudSessionEnvironmentIdentity(remoteSession),
    pendingEvents,
    etaMs,
    kind,
  };
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
