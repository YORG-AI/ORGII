/**
 * Org2CloudSyncEngine — owner-session summary cold-start cache.
 *
 * Read one server summary page per org/start so a restart can prove that
 * already-published imported transcripts are unchanged without reopening
 * and normalizing every CLI history file. The cache is pass-local /
 * start-scoped (see `reset()`): keeping a second copy of every remote
 * session for the app lifetime would trade I/O pressure for RAM pressure.
 */
import { createLogger } from "@src/hooks/logger";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync";

const log = createLogger("Org2CloudSyncEngine");

export class Org2CloudSessionColdStart {
  /** Orgs whose owner-session summaries seeded the cold-start push caches. */
  private readonly hydratedOrgIds = new Set<string>();

  constructor(private readonly client: Org2CloudSyncClientDeps) {}

  reset(): void {
    this.hydratedOrgIds.clear();
  }

  prune(currentOrgIds: ReadonlySet<string>): void {
    for (const orgId of this.hydratedOrgIds) {
      if (!currentOrgIds.has(orgId)) this.hydratedOrgIds.delete(orgId);
    }
  }

  async loadSessionSummariesForColdStart(
    auth: Org2CloudAuthState,
    orgId: string,
    generation: number,
    isCurrentGeneration: (generation: number) => boolean
  ): Promise<Map<string, RemoteTeammateSessionMetadata> | undefined> {
    if (this.hydratedOrgIds.has(orgId)) return undefined;
    try {
      const result = await this.client.listOrgSessions(auth.accessToken, orgId);
      if (!isCurrentGeneration(generation)) return undefined;
      this.hydratedOrgIds.add(orgId);
      return new Map(
        result.sessions
          .filter((row) => row.ownerUserId === auth.userId && !row.deletedAt)
          .map((row) => [row.sourceSessionId, row])
      );
    } catch (error) {
      log.warn(
        `cloud session summary hydration failed for org ${orgId}:`,
        error
      );
      return undefined;
    }
  }
}
