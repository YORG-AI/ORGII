/**
 * ORG2 Cloud helpers for WebDriver specs (cloud-parity Phase D).
 *
 * Design contract (see cloud-org-ui.spec.mjs): rendered assertions stay on
 * the production DOM path; these helpers only SEED store state that has no
 * WebDriver-reachable entry and READ ground truth back for assertions.
 *
 * Why each seam exists:
 * - `cloudSeedAuthState`: `org2CloudAuthAtom` is persisted via
 *   `atomWithStorage`, so a raw localStorage write from the spec would NOT
 *   update the mounted atom — the JWT (minted by the driver through the
 *   harness's password-user trick, or pointed at a fake offline endpoint)
 *   must be written through the store.
 * - `cloudSeedOrgs`: `org2CloudOrgsAtom` is in-memory and normally filled by
 *   `list_my_orgs`; offline coverage needs a deterministic org row.
 * - `cloudSeedPendingInvite`: the pending-invite atom is set by the OS deep
 *   link handler (`orgii://cloud/join`), which WebDriver cannot fire; the
 *   helper still runs the PRODUCTION link parser so a malformed link fails
 *   exactly like it would in the app.
 * - `cloudOpenSyncLevelDialog`: the dialog's only production entry is a
 *   native Tauri context-menu item (not DOM); the helper sets the same atom
 *   that menu action sets.
 * - `cloudTagSessionToOrg`: mirrors MoveToOrgDialog's write (same atom, same
 *   `withTag` helper) so share/sync-level eligibility flows are exercised
 *   with production state shapes.
 */
import { invalidateProjectCache, projectApi } from "@src/api/http/project";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { cloudSyncLevelSessionAtom } from "@src/features/Org2Cloud/CloudSyncLevelDialog/useCloudSyncLevelDialog";
import { collectAddressableThreads } from "@src/features/Org2Cloud/addressComments";
import { org2CloudSharingFloorAtom } from "@src/features/Org2Cloud/org2CloudAccessSettings";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import type { Org2CloudAuthState } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  listMyOrgs,
  listOrgMembers,
} from "@src/features/Org2Cloud/org2CloudClient";
import {
  org2CloudCommentsSignalAtom,
  orgCommentsKey,
  sessionCommentsKey,
} from "@src/features/Org2Cloud/org2CloudCommentsBus";
import {
  parseCloudInviteDeepLink,
  parseCloudShareDeepLink,
} from "@src/features/Org2Cloud/org2CloudOrgManagement";
import {
  isOrg2CloudOrgsConverging,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
  org2CloudOrgsRequestEpochAtom,
  org2CloudRosterVersionAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import type { Org2CloudOrg } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudPendingInviteAtom } from "@src/features/Org2Cloud/org2CloudPendingInviteAtom";
import { queueOrg2CloudPendingShareAtom } from "@src/features/Org2Cloud/org2CloudPendingShareAtom";
import {
  org2CloudPresenceAtom,
  org2CloudPresenceOutboundAtom,
  resolveCloudSessionRefs,
} from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { org2CloudSessionCommentsAtom } from "@src/features/Org2Cloud/org2CloudSessionCommentsAtom";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import { rewriteSessionEvents } from "@src/features/Org2Cloud/org2CloudSyncClient";
import { org2CloudSyncEngine } from "@src/features/Org2Cloud/org2CloudSyncEngine";
import { resolveSessionCommentTarget } from "@src/features/Org2Cloud/sessionCommentTarget";
import { resolveShareableScopeKeys } from "@src/features/TeamCollaboration/repoScopeResolver";
import {
  cloudOrgIdsForSession,
  cloudOrgToken,
  sessionOrgTagsAtom,
  withTag,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import { projectDataChangedSignalAtom } from "@src/hooks/project";
import { RemoteTeammateSessionMetadataSchema } from "@src/store/collaboration/protocol";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import {
  chatPanelSelectedCloudOrgAtom,
  chatPanelSelectedWorkItemAtom,
} from "@src/store/ui/chatPanelAtom";
import { isTerminalStatus } from "@src/types/session/session";

import { asError } from "../result";
import type { E2EStore, Err, Json, Result } from "../types";

interface CloudHelperDeps {
  store: E2EStore;
}

export function createCloudHelpers({ store }: CloudHelperDeps) {
  const cloudSeedAuthState = async (opts: {
    supabaseUrl: string;
    anonKey: string;
    userId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    displayName?: string;
  }): Promise<Result<{ userId: string }>> => {
    try {
      const state: Org2CloudAuthState = {
        kind: "org2_cloud",
        supabaseUrl: opts.supabaseUrl,
        supabaseAnonKey: opts.anonKey,
        userId: opts.userId,
        accessToken: opts.accessToken,
        refreshToken: opts.refreshToken,
        expiresAt: opts.expiresAt,
        profile: opts.displayName
          ? { displayName: opts.displayName }
          : undefined,
      };
      store.set(org2CloudAuthAtom, state);
      return { ok: true, userId: opts.userId };
    } catch (err) {
      return asError(err);
    }
  };

  /** Sign-out reset (also clears `org2CloudOrgsAtom` via its auth effect). */
  const cloudClearAuthState = async (): Promise<{ ok: true } | Err> => {
    try {
      store.set(org2CloudAuthAtom, null);
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudReadAuthState = async (): Promise<
    Result<{ signedIn: boolean; userId: string | null }>
  > => {
    try {
      const auth = store.get(org2CloudAuthAtom);
      return {
        ok: true,
        signedIn: auth !== null,
        userId: auth?.userId ?? null,
      };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Create the durable local Project-org alias that a prior cloud sign-in
   * leaves behind. This is deterministic setup for signed-out selector
   * regressions; the assertion still opens and inspects the production
   * dropdown through WebDriver.
   */
  const cloudSeedProjectOrgAlias = async (opts: {
    localOrgId: string;
    externalOrgId: string;
    name: string;
  }): Promise<Result<{ localOrgId: string; externalOrgId: string }>> => {
    try {
      const existing = (await projectApi.readOrgs()).find(
        (org) => org.id === opts.localOrgId
      );
      if (!existing) {
        await projectApi.createOrg({ id: opts.localOrgId, name: opts.name });
      }
      const aliased = await projectApi.configureOrgCollabSync({
        orgId: opts.localOrgId,
        externalOrgId: opts.externalOrgId,
      });
      store.set(projectDataChangedSignalAtom, (current) => current + 1);
      return {
        ok: true,
        localOrgId: aliased.id,
        externalOrgId: aliased.external_org_id ?? "",
      };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Overwrite `org2CloudOrgsAtom`. Callers must seed auth FIRST and let the
   * (failing, offline) `list_my_orgs` fetch settle — that fetch degrades to
   * `[]` and would clobber an earlier seed. Idempotent, so specs re-seed
   * inside a waitUntil until the sidebar picks the org up.
   */
  const cloudSeedOrgs = async (opts: {
    orgs: Array<{ orgId: string; name: string; role: string }>;
  }): Promise<Result<{ count: number }>> => {
    try {
      const orgs: Org2CloudOrg[] = opts.orgs.map((org) => ({
        orgId: org.orgId,
        name: org.name,
        role: org.role,
      }));
      store.set(org2CloudOrgsAtom, orgs);
      // Seeding orgs simulates a completed `list_my_orgs`, so mark the roster
      // loaded too — otherwise a cloud-aliased work item reads as
      // membership-pending and blocks its start.
      store.set(org2CloudOrgsLoadedAtom, true);
      return { ok: true, count: orgs.length };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudListOrgs = async (): Promise<Result<{ orgs: Json[] }>> => {
    try {
      return {
        ok: true,
        orgs: store.get(org2CloudOrgsAtom).map((org) => ({
          orgId: org.orgId,
          name: org.name,
          role: org.role,
        })),
      };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * E2E-only roster diagnostic. Reads the rendered store's invalidation
   * generation and the same authoritative member RPC used by the panel, but
   * never mutates either. Returning only public roster fields keeps tokens out
   * of failure logs.
   */
  const cloudInspectMemberRoster = async (opts: {
    orgId: string;
  }): Promise<
    Result<{
      rosterVersion: number;
      members: Json[] | null;
    }>
  > => {
    try {
      const auth = store.get(org2CloudAuthAtom);
      const members = auth
        ? await listOrgMembers(auth.accessToken, opts.orgId)
        : null;
      return {
        ok: true,
        rosterVersion: store.get(org2CloudRosterVersionAtom)[opts.orgId] ?? 0,
        members:
          members?.map((member) => ({
            userId: member.userId,
            displayName: member.displayName ?? null,
            role: member.role,
            status: member.status,
          })) ?? null,
      };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * E2E-only convergence diagnostic: compare the rendered store roster with
   * a fresh authoritative `list_my_orgs` call made using the same auth token.
   * This never mutates the store and deliberately excludes token material.
   */
  const cloudInspectRosterState = async (): Promise<
    Result<{
      orgs: Json[];
      directOrgs: Json[] | null;
      loaded: boolean;
      requestEpoch: number;
      converging: boolean;
    }>
  > => {
    try {
      const auth = store.get(org2CloudAuthAtom);
      const directOrgs = auth ? await listMyOrgs(auth.accessToken) : null;
      return {
        ok: true,
        orgs: store.get(org2CloudOrgsAtom).map((org) => ({
          orgId: org.orgId,
          name: org.name,
          role: org.role,
        })),
        directOrgs:
          directOrgs?.map((org) => ({
            orgId: org.orgId,
            name: org.name,
            role: org.role,
          })) ?? null,
        loaded: store.get(org2CloudOrgsLoadedAtom),
        requestEpoch: store.get(org2CloudOrgsRequestEpochAtom),
        converging: isOrg2CloudOrgsConverging(store),
      };
    } catch (err) {
      return asError(err);
    }
  };

  /** Distinguish a missed remote apply from a stale frontend project cache. */
  const cloudInspectProjectState = async (opts: {
    projectSlug: string;
    workItemId?: string;
  }): Promise<
    Result<{
      cachedPresent: boolean;
      freshPresent: boolean;
      cachedSlugs: string[];
      freshSlugs: string[];
      projectOrgId: string | null;
      workItem: Json | null;
      enrichedWorkItem: Json | null;
      scopedEnrichedWorkItem: Json | null;
      selectedWorkItem: Json | null;
      dataChangedSignal: number;
      pendingOutbox: Json[];
    }>
  > => {
    try {
      const cached = await projectApi.readProjects();
      invalidateProjectCache();
      const fresh = await projectApi.readProjects();
      const project = fresh.find(
        (candidate) => candidate.slug === opts.projectSlug
      );
      const workItems = project
        ? await projectApi.readWorkItems(opts.projectSlug, {
            orgId: project.meta.org_id,
          })
        : [];
      const workItem = opts.workItemId
        ? workItems.find(
            (candidate) => candidate.frontmatter.id === opts.workItemId
          )
        : undefined;
      const [enrichedItems, scopedEnrichedItems] = project
        ? await Promise.all([
            projectApi.readWorkItemsEnriched(opts.projectSlug),
            projectApi.readWorkItemsEnriched(opts.projectSlug, {
              orgId: project.meta.org_id,
            }),
          ])
        : [[], []];
      const enrichedWorkItem = opts.workItemId
        ? enrichedItems.find((candidate) => candidate.id === opts.workItemId)
        : undefined;
      const scopedEnrichedWorkItem = opts.workItemId
        ? scopedEnrichedItems.find(
            (candidate) => candidate.id === opts.workItemId
          )
        : undefined;
      const selectedWorkItem = store.get(chatPanelSelectedWorkItemAtom);
      const pendingOutbox = project
        ? await projectApi.listCollabOutboxPendingIds(project.meta.org_id)
        : [];
      return {
        ok: true,
        cachedPresent: cached.some(
          (project) => project.slug === opts.projectSlug
        ),
        freshPresent: fresh.some(
          (project) => project.slug === opts.projectSlug
        ),
        cachedSlugs: cached.map((project) => project.slug),
        freshSlugs: fresh.map((project) => project.slug),
        projectOrgId: project?.meta.org_id ?? null,
        workItem: workItem
          ? {
              id: workItem.frontmatter.id,
              shortId: workItem.frontmatter.short_id,
              status: workItem.frontmatter.status,
              executionLock: workItem.frontmatter.execution_lock ?? null,
            }
          : null,
        enrichedWorkItem: enrichedWorkItem
          ? {
              id: enrichedWorkItem.id,
              shortId: enrichedWorkItem.shortId,
              executionLock: enrichedWorkItem.executionLock ?? null,
            }
          : null,
        scopedEnrichedWorkItem: scopedEnrichedWorkItem
          ? {
              id: scopedEnrichedWorkItem.id,
              shortId: scopedEnrichedWorkItem.shortId,
              executionLock: scopedEnrichedWorkItem.executionLock ?? null,
            }
          : null,
        selectedWorkItem: selectedWorkItem
          ? {
              id: selectedWorkItem.workItem.session_id,
              shortId: selectedWorkItem.shortId,
              status:
                selectedWorkItem.workItem.workItemStatus ??
                selectedWorkItem.workItem.status ??
                null,
              executionLock: selectedWorkItem.workItem.executionLock ?? null,
            }
          : null,
        dataChangedSignal: store.get(projectDataChangedSignalAtom),
        pendingOutbox: pendingOutbox.map((entry) => ({
          kind: entry.kind,
          entityId: entry.entityId,
        })),
      };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudSeedRepoScopes = async (opts: {
    orgId: string;
    repoScopes: string[];
  }): Promise<Result<{ count: number }>> => {
    try {
      store.set(org2CloudRepoScopesAtom, (current) => ({
        ...current,
        [opts.orgId]: [...opts.repoScopes],
      }));
      return { ok: true, count: opts.repoScopes.length };
    } catch (err) {
      return asError(err);
    }
  };

  /** Await the production git-remote resolver used by the share gate. */
  const cloudResolveRepoScopeKeys = async (opts: {
    repoPath: string;
  }): Promise<Result<{ keys: string[] | null }>> => {
    try {
      return {
        ok: true,
        keys: await resolveShareableScopeKeys(opts.repoPath),
      };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudSeedRemoteSessions = async (opts: {
    orgId: string;
    sessions: Json[];
  }): Promise<Result<{ count: number }>> => {
    try {
      const rows = opts.sessions.map((session) =>
        RemoteTeammateSessionMetadataSchema.parse(session)
      );
      store.set(org2CloudRemoteSessionsAtom, (current) => ({
        ...current,
        [opts.orgId]: {
          rows,
          state: "ready",
          fetchedAt: Date.now(),
        },
      }));
      return { ok: true, count: rows.length };
    } catch (err) {
      return asError(err);
    }
  };

  /** Read-only E2E diagnostics for the collaboration state feeding UI gates. */
  const cloudInspectDebugState = async (opts: {
    sessionId?: string;
  }): Promise<Result<{ debug: Json }>> => {
    try {
      const sharingFloorByOrg = store.get(org2CloudSharingFloorAtom);
      const remoteEntries = store.get(org2CloudRemoteSessionsAtom);
      const remote = Object.fromEntries(
        Object.entries(remoteEntries).map(([orgId, entry]) => [
          orgId,
          {
            state: entry.state,
            fetchedAt: entry.fetchedAt,
            rows: entry.rows.map((row) => ({
              sourceSessionId: row.sourceSessionId,
              accessMode: row.accessMode ?? null,
              eventsEpoch: row.eventsEpoch ?? null,
              unresolvedCommentCount: row.unresolvedCommentCount ?? null,
            })),
          },
        ])
      );
      if (!opts.sessionId) {
        return { ok: true, debug: { remote, sharingFloorByOrg } };
      }

      const session = store
        .get(sessionsAtom)
        .find((candidate) => candidate.session_id === opts.sessionId);
      const orgs = store.get(org2CloudOrgsAtom);
      const tags = store.get(sessionOrgTagsAtom);
      const preferredOrgId =
        store.get(chatPanelSelectedCloudOrgAtom)?.orgId ?? null;
      const target = resolveSessionCommentTarget({
        session,
        cloudOrgs: orgs,
        tags,
        preferredOrgId,
      });
      const commentEntry = target
        ? store.get(org2CloudSessionCommentsAtom)[
            sessionCommentsKey(target.orgId, target.sessionId)
          ]
        : undefined;
      const addressableThreads = collectAddressableThreads(
        commentEntry?.comments ?? []
      );
      return {
        ok: true,
        debug: {
          remote,
          session: session
            ? {
                sessionId: session.session_id,
                status: session.status ?? null,
                importedFrom: session.importedFrom ?? null,
                terminal: isTerminalStatus(String(session.status)),
              }
            : null,
          tags: tags[opts.sessionId] ?? [],
          cloudOrgIds: cloudOrgIdsForSession(tags, opts.sessionId),
          preferredOrgId,
          target,
          comments: commentEntry
            ? {
                state: commentEntry.state,
                errorMessage: commentEntry.errorMessage ?? null,
                count: commentEntry.comments.length,
                rows: commentEntry.comments.map((comment) => ({
                  id: comment.id,
                  body: comment.body,
                  editedAt: comment.editedAt ?? null,
                  deletedAt: comment.deletedAt ?? null,
                })),
                addressableHeadIds: addressableThreads.map(
                  (thread) => thread.headId
                ),
                signalVersion: target
                  ? (store.get(org2CloudCommentsSignalAtom)[
                      sessionCommentsKey(target.orgId, target.sessionId)
                    ] ?? 0)
                  : 0,
                orgSignalVersion: target
                  ? (store.get(org2CloudCommentsSignalAtom)[
                      orgCommentsKey(target.orgId)
                    ] ?? 0)
                  : 0,
              }
            : null,
        },
      };
    } catch (err) {
      return asError(err);
    }
  };

  /** Read-only awareness diagnostic for dual-instance rendered tests. */
  const cloudInspectPresence = async (): Promise<
    Result<{
      presence: Json;
      outbound: Json;
      activeSessionId: string | null;
      resolvedSessionRefs: Json[];
      visibilityState: string;
    }>
  > => {
    try {
      const activeSessionId = store.get(activeSessionIdAtom);
      const activeSession = activeSessionId
        ? store
            .get(sessionsAtom)
            .find((session) => session.session_id === activeSessionId)
        : undefined;
      return {
        ok: true,
        presence: store.get(org2CloudPresenceAtom),
        outbound: store.get(org2CloudPresenceOutboundAtom),
        activeSessionId,
        resolvedSessionRefs: activeSession
          ? resolveCloudSessionRefs(
              activeSession,
              cloudOrgIdsForSession(
                store.get(sessionOrgTagsAtom),
                activeSession.session_id
              )
            ).map((ref) => ({
              orgId: ref.orgId,
              bareSessionId: ref.bareSessionId,
            }))
          : [],
        visibilityState: document.visibilityState,
      };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Publish the already-seeded local event snapshot through the production
   * managed-cloud segment codec/client. This is an E2E fixture boundary: the
   * rendered test still opts into full replay and drives import/fork through
   * UI, while avoiding the sync engine's one-minute background cadence.
   */
  const cloudPublishSeededSessionEvents = async (opts: {
    orgId: string;
    sessionId: string;
    newEpoch?: number;
  }): Promise<Result<{ eventCount: number; epoch: number }>> => {
    try {
      const auth = store.get(org2CloudAuthAtom);
      if (!auth) {
        return {
          ok: false,
          error: "cloudPublishSeededSessionEvents: cloud auth is required",
        };
      }
      const snapshot = await eventStoreProxy.getSnapshot(opts.sessionId);
      const epoch = opts.newEpoch ?? 1;
      await rewriteSessionEvents(auth.accessToken, {
        orgId: opts.orgId,
        sessionId: opts.sessionId,
        newEpoch: epoch,
        frozenSegments: [],
        tail: snapshot.events.length > 0 ? snapshot.events : null,
        totalCount: snapshot.events.length,
      });
      return { ok: true, eventCount: snapshot.events.length, epoch };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Drain the production cloud sync engine immediately. Rendered specs use
   * this only as a deterministic clock boundary after a real UI mutation;
   * the mutation, outbox, adapters, RPCs, apply path, and UI refresh all stay
   * production code.
   */
  const cloudRunSyncPass = async (): Promise<{ ok: true } | Err> => {
    try {
      await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudSeedPendingInvite = async (opts: {
    link: string;
  }): Promise<Result<{ inviteCode: string }>> => {
    try {
      // Production parser: a link the deep-link handler would reject must
      // fail here too, not silently open the dialog.
      const parsed = parseCloudInviteDeepLink(opts.link);
      if (!parsed) {
        return {
          ok: false,
          error: `cloudSeedPendingInvite: not a valid orgii://cloud/join link: ${opts.link}`,
        };
      }
      store.set(org2CloudPendingInviteAtom, parsed);
      return { ok: true, inviteCode: parsed.inviteCode };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudSeedPendingShare = async (opts: {
    link: string;
  }): Promise<Result<{ shareToken: string }>> => {
    try {
      const parsed = parseCloudShareDeepLink(opts.link);
      if (!parsed) {
        return {
          ok: false,
          error: `cloudSeedPendingShare: not a valid orgii://cloud/session?share= link: ${opts.link}`,
        };
      }
      store.set(queueOrg2CloudPendingShareAtom, parsed);
      return { ok: true, shareToken: parsed.shareToken };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudTagSessionToOrg = async (opts: {
    sessionId: string;
    orgId: string;
  }): Promise<{ ok: true } | Err> => {
    try {
      store.set(
        sessionOrgTagsAtom,
        withTag(
          store.get(sessionOrgTagsAtom),
          opts.sessionId,
          cloudOrgToken(opts.orgId)
        )
      );
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudOpenSyncLevelDialog = async (opts: {
    sessionId: string;
  }): Promise<Result<{ sessionId: string }>> => {
    try {
      const session = store
        .get(sessionsAtom)
        .find((row) => row.session_id === opts.sessionId);
      if (!session) {
        return {
          ok: false,
          error: `cloudOpenSyncLevelDialog: session ${opts.sessionId} not in sessionsAtom — seed it first`,
        };
      }
      store.set(cloudSyncLevelSessionAtom, session);
      return { ok: true, sessionId: opts.sessionId };
    } catch (err) {
      return asError(err);
    }
  };

  const cloudCloseSyncLevelDialog = async (): Promise<{ ok: true } | Err> => {
    try {
      store.set(cloudSyncLevelSessionAtom, null);
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    cloudSeedAuthState,
    cloudClearAuthState,
    cloudReadAuthState,
    cloudSeedProjectOrgAlias,
    cloudSeedOrgs,
    cloudListOrgs,
    cloudInspectMemberRoster,
    cloudInspectRosterState,
    cloudInspectProjectState,
    cloudSeedRepoScopes,
    cloudResolveRepoScopeKeys,
    cloudSeedRemoteSessions,
    cloudInspectDebugState,
    cloudInspectPresence,
    cloudPublishSeededSessionEvents,
    cloudRunSyncPass,
    cloudSeedPendingInvite,
    cloudSeedPendingShare,
    cloudTagSessionToOrg,
    cloudOpenSyncLevelDialog,
    cloudCloseSyncLevelDialog,
  };
}
