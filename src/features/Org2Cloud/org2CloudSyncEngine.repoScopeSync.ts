/**
 * Org2CloudSyncEngine — repo-scope mirror hydration + scope-key resolution.
 *
 * Repo scopes are the HARD boundary the session-push pass matches candidate
 * sessions against (server-enforced since the scope governance change).
 * This module owns the TTL-gated pull of `org2CloudRepoScopesAtom` from
 * `cloud_get_org_repo_scopes`, plus the pure per-session scope-key lookup
 * used to match a session's checkout against those scopes.
 */
import { createLogger } from "@src/hooks/logger";
import type { Session } from "@src/store/session/sessionAtom/types";

import { persistedScopeKeysForImportedSession } from "../TeamCollaboration/importedSessionScopeMatch";
import {
  peekShareableScopeKeys,
  primeShareableScopeKey,
} from "../TeamCollaboration/repoScopeResolver";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync";
import { org2CloudRepoScopesAtom } from "./org2CloudSyncAtoms";
import { SCOPE_HYDRATE_THROTTLE_MS } from "./org2CloudSyncEngine.constants";
import type { CloudStore } from "./org2CloudSyncLifecycle";

const log = createLogger("Org2CloudSyncEngine");

/** ALL shareable keys for the session's checkout (multi-remote), from the
 * resolver cache. undefined = resolution in flight (primed here). */
export function getSessionScopeKeys(
  session: Pick<
    Session,
    "session_id" | "repoPath" | "repoRemoteUrls" | "parentSessionId"
  >
): string[] | null | undefined {
  const persistedKeys = persistedScopeKeysForImportedSession(session);
  if (persistedKeys !== undefined) return persistedKeys;
  if (!session.repoPath) return null;
  const keys = peekShareableScopeKeys(session.repoPath);
  if (keys === undefined) primeShareableScopeKey(session.repoPath);
  return keys;
}

export class Org2CloudRepoScopeSync {
  /** orgId → last repo-scope hydration attempt (TTL-gated per pass). */
  private readonly hydratedAtMs = new Map<string, number>();
  /** Orgs whose scopes this RUN has confirmed against the server. The
   * persisted mirror is restored empty-or-stale on boot, and an empty scope
   * list makes every candidate read as out-of-scope — which retracts live
   * shared rows and drops their org tags. Destructive scope decisions wait
   * for a confirmed fetch; pushes still run off the mirror. */
  private readonly serverConfirmedOrgIds = new Set<string>();

  constructor(
    private readonly getStore: () => CloudStore | null,
    private readonly client: Org2CloudSyncClientDeps
  ) {}

  reset(): void {
    this.hydratedAtMs.clear();
    this.serverConfirmedOrgIds.clear();
  }

  prune(currentOrgIds: ReadonlySet<string>): void {
    for (const orgId of this.hydratedAtMs.keys()) {
      if (!currentOrgIds.has(orgId)) this.hydratedAtMs.delete(orgId);
    }
    for (const orgId of this.serverConfirmedOrgIds) {
      if (!currentOrgIds.has(orgId)) this.serverConfirmedOrgIds.delete(orgId);
    }
  }

  /** True once THIS run has read the org's scopes from the server. Gates
   * every scope-driven retract/untag: a mirror that was never confirmed
   * cannot prove a session is out of scope. */
  hasServerConfirmedScopes(orgId: string): boolean {
    return this.serverConfirmedOrgIds.has(orgId);
  }

  /** Realtime full-recovery invalidation (or a plain reconnect when
   * `orgId` is omitted): force the next pass to re-hydrate past the TTL. */
  invalidate(orgId?: string): void {
    if (orgId) this.hydratedAtMs.delete(orgId);
    else this.hydratedAtMs.clear();
  }

  /**
   * Best-effort, event-throttled hydration of `org2CloudRepoScopesAtom` from
   * `cloud_get_org_repo_scopes`. Failures only log — the mirror keeps its
   * last-known scopes and the pass proceeds (offline pushes still work).
   *
   * Known narrow race (accepted): a hydration response fetched BEFORE a
   * concurrent panel save resolves can land AFTER it and briefly revert the
   * mirror to the pre-save scopes. Self-heals on the panel's own post-save
   * refetch / the next concrete sync event, so no versioning is layered on
   * here.
   */
  async hydrateRepoScopes(
    auth: Org2CloudAuthState,
    orgs: Array<{ orgId: string }>,
    generation: number,
    isCurrentGeneration: (generation: number) => boolean
  ): Promise<void> {
    for (const org of orgs) {
      const lastAttempt = this.hydratedAtMs.get(org.orgId) ?? 0;
      if (Date.now() - lastAttempt < SCOPE_HYDRATE_THROTTLE_MS) continue;
      this.hydratedAtMs.set(org.orgId, Date.now());
      try {
        const state = await this.client.getOrgRepoScopes(
          auth.accessToken,
          org.orgId
        );
        if (!isCurrentGeneration(generation)) return;
        this.getStore()?.set(org2CloudRepoScopesAtom, (current) => ({
          ...current,
          [org.orgId]: state.repoScopes,
        }));
        this.serverConfirmedOrgIds.add(org.orgId);
      } catch (error) {
        if (!isCurrentGeneration(generation)) return;
        log.warn(`repo-scope hydration failed for org ${org.orgId}:`, error);
      }
    }
  }
}
