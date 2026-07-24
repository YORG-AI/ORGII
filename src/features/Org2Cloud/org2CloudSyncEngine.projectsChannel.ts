/**
 * Org2CloudSyncEngine — projects / work items channel (cloud-parity Phase B).
 *
 * After the session push, every org drives the SAME `ProjectSyncChannel` +
 * Rust bridge as the self-hosted engine, backed by the cloud RPC adapter
 * (`org2CloudProjectsClient`). The pulled state comes from
 * `cloud_list_org_collab_state` behind a persisted per-org cursor
 * (`org2CloudCollabStateCursorsAtom`, serverTime − 2s overlap), bypassed
 * once per engine start for a COMPLETE listing — a row that leaves the
 * visible set without a tombstone can only be proven absent against the
 * full state. Work items are org-wide: no repo-scope selection.
 */
import { createLogger } from "@src/hooks/logger";

import { ProjectSyncChannel } from "../TeamCollaboration/engine/ProjectSyncChannel";
import type { ProjectSyncBridge } from "../TeamCollaboration/engine/projectSyncBridge";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import type { Org2CloudOrg } from "./org2CloudOrgsAtom";
import { ensureProjectOrgForCloudOrg } from "./org2CloudProjectOrgAlias";
import type { CloudProjectsRpc } from "./org2CloudProjectsClient";
import {
  createCloudProjectSyncClient,
  isOrg2ProjectsErrorCode,
  toCollabOrgState,
} from "./org2CloudProjectsClient";
import { org2CloudCollabStateCursorsAtom } from "./org2CloudSyncAtoms";
import { CURSOR_OVERLAP_MS } from "./org2CloudSyncEngine.constants";
import type { CloudStore } from "./org2CloudSyncLifecycle";

const log = createLogger("Org2CloudSyncEngine");

/** Projects/work-items RPC seam (Phase B), same fetch-free-fakes purpose. */
export type Org2CloudProjectsClientDeps = CloudProjectsRpc;

export class Org2CloudProjectsChannel {
  /** Cloud orgId → aliased local project-org id (ensured once per start). */
  private readonly projectOrgAliasIds = new Map<string, string>();
  /** Orgs whose CURRENT start already pulled one COMPLETE collab-state listing. */
  private readonly fullCollabStateOrgIds = new Set<string>();

  constructor(
    private readonly getStore: () => CloudStore | null,
    private readonly projectsClient: Org2CloudProjectsClientDeps,
    private readonly projectSyncBridge: ProjectSyncBridge
  ) {}

  reset(): void {
    this.projectOrgAliasIds.clear();
    this.fullCollabStateOrgIds.clear();
  }

  prune(currentOrgIds: ReadonlySet<string>): void {
    for (const orgId of this.projectOrgAliasIds.keys()) {
      if (!currentOrgIds.has(orgId)) this.projectOrgAliasIds.delete(orgId);
    }
    for (const orgId of this.fullCollabStateOrgIds) {
      if (!currentOrgIds.has(orgId)) this.fullCollabStateOrgIds.delete(orgId);
    }
  }

  /** Realtime full-recovery invalidation: bypass the cursor once more for a
   * COMPLETE listing on this org's next pass. */
  invalidateFullListing(orgId: string): void {
    this.fullCollabStateOrgIds.delete(orgId);
  }

  /**
   * Local project-org alias for one cloud org (`sync_provider='orgii_collab'`
   * + `external_org_id=<cloudOrgId>`), ensured once per engine start. The
   * create/join flows stamp the alias too — this is the self-heal for orgs
   * that predate Phase B (or whose stamp failed). null ⇒ skip the org this
   * pass and retry next pass.
   */
  async ensureProjectOrgAlias(org: Org2CloudOrg): Promise<string | null> {
    const cached = this.projectOrgAliasIds.get(org.orgId);
    if (cached) return cached;
    try {
      const projectOrg = await ensureProjectOrgForCloudOrg(org);
      this.projectOrgAliasIds.set(org.orgId, projectOrg.id);
      return projectOrg.id;
    } catch (error) {
      log.warn(
        `project-org alias ensure failed for cloud org ${org.orgId}:`,
        error
      );
      return null;
    }
  }

  /**
   * One org's projects/work-items cycle: pull the collab-state delta, hand
   * it to the shared ProjectSyncChannel (apply + outbox drain/push/ack),
   * then advance the persisted cursor. Once per engine start the cursor is
   * bypassed for a COMPLETE listing — a row that leaves the visible set
   * without a tombstone can only be proven absent against the full state
   * (same revocation-absence rationale as the session listing).
   */
  async syncOrgProjects(
    auth: Org2CloudAuthState,
    org: Org2CloudOrg,
    generation: number,
    options: { pushOutbox: boolean },
    deps: {
      isCurrentGeneration: (generation: number) => boolean;
      scheduleProjectPushRetry: () => void;
    }
  ): Promise<void> {
    const store = this.getStore();
    if (!store) return;
    const projectOrgId = await this.ensureProjectOrgAlias(org);
    if (!deps.isCurrentGeneration(generation) || !projectOrgId) return;

    const isFullListing = !this.fullCollabStateOrgIds.has(org.orgId);
    const since = isFullListing
      ? undefined
      : store.get(org2CloudCollabStateCursorsAtom)[org.orgId];
    const state = await this.projectsClient.listOrgCollabState(
      auth.accessToken,
      org.orgId,
      since
    );
    if (!deps.isCurrentGeneration(generation)) return;

    // Same channel + Rust bridge as the retired self-hosted engine; the cloud
    // client owns authentication through its captured JWT.
    const channel = new ProjectSyncChannel({
      client: createCloudProjectSyncClient(
        auth.accessToken,
        this.projectsClient
      ),
      bridge: this.projectSyncBridge,
    });
    const cycle = await channel.sync(
      {
        org: { id: org.orgId, name: org.name, projectOrgId, createdAt: "" },
        state: toCollabOrgState(state),
      },
      { pushOutbox: options.pushOutbox }
    );
    if (!deps.isCurrentGeneration(generation)) return;

    // The channel acks per-row push failures instead of throwing (Rust-side
    // backoff owns the entries), so the entitlement rejection from the GATED
    // upsert RPCs — the projects plane's only ORG2_SYNC_DISABLED source; the
    // listing RPC we await directly is ungated — can only surface through
    // the cycle result. Rethrow it into the same backoff+toast path as the
    // session plane; otherwise a disabled org re-drains its outbox every
    // pass forever with no user-visible signal.
    const syncDisabled = cycle.pushErrors.find((error) =>
      isOrg2ProjectsErrorCode(error, "ORG2_SYNC_DISABLED")
    );
    if (syncDisabled !== undefined) throw syncDisabled;
    if (cycle.pushErrors.length > 0) deps.scheduleProjectPushRetry();

    this.fullCollabStateOrgIds.add(org.orgId);
    // Anchor the delta cursor on the server clock minus a safety overlap so
    // client skew cannot skip rows (consumers are idempotent) — the
    // self-hosted delta-cursor discipline.
    const cursorAt = state.serverTime
      ? new Date(
          new Date(state.serverTime).getTime() - CURSOR_OVERLAP_MS
        ).toISOString()
      : new Date().toISOString();
    store.set(org2CloudCollabStateCursorsAtom, (current) => ({
      ...current,
      [org.orgId]: cursorAt,
    }));
  }
}
