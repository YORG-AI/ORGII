import { buildCloudSessionWirePageClient } from "@src/features/Org2Cloud/org2CloudBackendAdapter";
import { listOrgSessions } from "@src/features/Org2Cloud/org2CloudSyncClient";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type {
  ForkSessionResult,
  ForkTeammateSessionOptions,
} from "./forkSession";
import { forkTeammateSession } from "./forkSession";

export interface CloudSessionForkOrigin {
  orgId: string;
  sourceSessionId: string;
}

/** The live remote row for a cloud source, excluding retained tombstones. */
export function pickCloudRemoteSession(
  remoteSessions: readonly RemoteTeammateSessionMetadata[],
  origin: CloudSessionForkOrigin
): RemoteTeammateSessionMetadata | undefined {
  return remoteSessions.find(
    (session) =>
      session.orgId === origin.orgId &&
      session.sourceSessionId === origin.sourceSessionId &&
      !session.deletedAt
  );
}

export interface AuthenticatedCloudSessionForkDeps {
  listSessions: typeof listOrgSessions;
  buildClient: typeof buildCloudSessionWirePageClient;
  fork: (
    options: ForkTeammateSessionOptions
  ) => Promise<ForkSessionResult | null>;
}

const DEFAULT_DEPS: AuthenticatedCloudSessionForkDeps = {
  listSessions: listOrgSessions,
  buildClient: buildCloudSessionWirePageClient,
  fork: forkTeammateSession,
};

export type AuthenticatedCloudSessionForkOutcome =
  | { status: "gone" }
  | { status: "forked"; result: ForkSessionResult | null };

/**
 * Re-fetch and fork a member-readable cloud source with an explicit local
 * execution choice. Shared by imported-session continuation and the owner's
 * @agent-on-immutable-history path so both flows enforce the same retention,
 * workspace, account, model, and provenance rules.
 */
export async function executeAuthenticatedCloudSessionFork(
  accessToken: string,
  origin: CloudSessionForkOrigin,
  deps: AuthenticatedCloudSessionForkDeps = DEFAULT_DEPS
): Promise<AuthenticatedCloudSessionForkOutcome> {
  const { sessions } = await deps.listSessions(accessToken, origin.orgId);
  const remoteSession = pickCloudRemoteSession(sessions, origin);
  if (!remoteSession) return { status: "gone" };
  const result = await deps.fork({
    client: deps.buildClient(accessToken),
    orgId: origin.orgId,
    remoteSession,
    promptForExecution: true,
  });
  return { status: "forked", result };
}
