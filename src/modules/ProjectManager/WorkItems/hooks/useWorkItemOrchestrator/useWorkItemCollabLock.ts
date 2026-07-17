/**
 * Cloud execution-lock awareness for the work item orchestrator
 * (design §16.6 / §16.9, cloud-parity Phase B/E).
 *
 * A shared work item is a native local row under a CLOUD-aliased project org
 * (`external_org_id` alias). This hook resolves whether the CURRENT work
 * item belongs to such an org and, if so, who holds the server-arbitrated
 * execution lock so the "start agent" affordance can disable instead of
 * double-starting.
 *
 * The lock itself is arbitrated by the server RPCs (cloudWorkItemLock.ts);
 * the holder (`executionLock.lockedByMemberId` — a cloud userId) syncs down
 * inside the work-item payload, so read paths stay purely local.
 */
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";

import { projectApi } from "@src/api/http/project";
import type { WorkItemExecutionLock } from "@src/api/http/project";
import {
  acquireCloudWorkItemLock,
  releaseCloudWorkItemLock,
} from "@src/features/Org2Cloud/cloudWorkItemLock";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  ensureCloudMemberNames,
  org2CloudMemberNamesAtom,
  resolveCloudMemberName,
} from "@src/features/Org2Cloud/org2CloudMemberNamesAtom";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  isCloudOrgMembershipPending,
  resolveCloudOrgForProjectOrg,
} from "@src/features/Org2Cloud/org2CloudProjectOrgAlias";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const logger = createLogger("useWorkItemCollabLock");

/**
 * Raised by `acquireLock` when the work item's collab membership could not
 * be resolved (readProject failed both in the resolve effect and in the
 * acquire-time retry). The caller must NOT start an agent on it: proceeding
 * would run WITHOUT server arbitration on a work item that may well be
 * cloud-synced, silently double-starting against a teammate.
 */
export class CollabMembershipUnresolvedError extends Error {
  constructor(projectSlug: string) {
    super(`collab membership unresolved for project ${projectSlug}`);
    this.name = "CollabMembershipUnresolvedError";
  }
}

export function isCollabMembershipUnresolvedError(
  error: unknown
): error is CollabMembershipUnresolvedError {
  return error instanceof CollabMembershipUnresolvedError;
}

/**
 * Result of resolving the work item's owning project org. "unresolved" is a
 * first-class state (readProject pending or failed): it must never be
 * conflated with "resolved: not collab", or a transient read failure lets an
 * agent start without server arbitration.
 */
export interface ResolvedCollabOrgResolution {
  status: "resolved";
  projectOrgId: string | null;
  /** Cloud org id when the project org is aliased to a managed-cloud org. */
  cloudOrgId: string | null;
}

type CollabOrgResolution =
  | { status: "unresolved" }
  | ResolvedCollabOrgResolution;

const UNRESOLVED: CollabOrgResolution = { status: "unresolved" };

/**
 * Resolve a project's owning org + cloud alias and KEEP the answer fresh
 * against `org2CloudOrgsAtom`. That atom is in-memory only and populated
 * asynchronously after sign-in / app start (`useOrg2CloudOrgs`), so a probe
 * that runs before `listMyOrgs` lands sees an empty atom and reports
 * `cloudOrgId: null` for a genuinely cloud-aliased org. Freezing that answer
 * would silently skip cloud lock arbitration for the lifetime of the mounted
 * view — so every change to the atom re-runs the probe and pushes a fresh
 * resolution.
 *
 * `onResolution` fires only with RESOLVED states; a failed probe keeps the
 * caller's current state so `acquireLock`'s unresolved-blocking discipline
 * holds. Concurrent triggers coalesce into one trailing re-probe. Returns an
 * unsubscribe function. Exported for the node vitest env (the repo has no
 * hook-render harness) — the hook's effect is a thin binding over this.
 */
export function watchCollabOrgResolution(
  projectSlug: string,
  onResolution: (resolution: ResolvedCollabOrgResolution) => void
): () => void {
  let stopped = false;
  let probing = false;
  let reprobeQueued = false;

  const probe = async (): Promise<void> => {
    if (probing) {
      reprobeQueued = true;
      return;
    }
    probing = true;
    try {
      const project = await projectApi.readProject(projectSlug);
      // Managed-cloud alias probe (cloud-parity Phase B): a failure here
      // keeps the current state exactly like a readProject failure — we
      // must never degrade to "resolved: not collab" on an error.
      const cloudOrgId = await resolveCloudOrgForProjectOrg(
        project.meta.org_id
      );
      // A null cloudOrgId during the cloud-orgs roster's first-load window is
      // indistinguishable from a genuinely non-cloud org. Emitting
      // "resolved: cloudOrgId null" here would let acquireLock start WITHOUT
      // server arbitration on a possibly cloud-synced item (the empty-atom
      // app-start / flaky-network race). Treat that pending state like a probe
      // failure — keep the caller "unresolved"; the atom-change re-probe
      // corrects it once the roster lands.
      if (
        cloudOrgId === null &&
        (await isCloudOrgMembershipPending(project.meta.org_id))
      ) {
        return;
      }
      if (!stopped) {
        onResolution({
          status: "resolved",
          projectOrgId: project.meta.org_id,
          cloudOrgId,
        });
      }
    } catch (error) {
      logger.warn("failed to resolve project org for collab lock", error);
      // Keep the caller's state: acquireLock retries inline and blocks when
      // it cannot prove the work item is not collab-synced.
    } finally {
      probing = false;
      if (reprobeQueued && !stopped) {
        reprobeQueued = false;
        void probe();
      }
    }
  };

  const unsubscribe = getInstrumentedStore().sub(org2CloudOrgsAtom, () => {
    void probe();
  });
  void probe();

  return () => {
    stopped = true;
    unsubscribe();
  };
}

interface LockHolderDisplay {
  heldByOther: boolean;
  holderName: string | null;
}

/**
 * Cloud lock holders are cloud userIds (our own id comes from the auth
 * atom); teammate display names resolve through the cached org member
 * roster, falling back to the raw id only when the member is unknown
 * (e.g. left the org).
 */
export function resolveLockHolder(
  lockedByMemberId: string | undefined | null,
  currentMemberId: string | undefined | null,
  displayName: string | null = null
): LockHolderDisplay {
  if (!lockedByMemberId) {
    return { heldByOther: false, holderName: null };
  }
  return {
    heldByOther: lockedByMemberId !== currentMemberId,
    holderName: displayName ?? lockedByMemberId,
  };
}

export interface UseWorkItemCollabLockOptions {
  projectSlug?: string | null;
  shortId?: string | null;
  /** Global work item id (== `orgii_work_items.id`), used as the lock key. */
  workItemId?: string | null;
  executionLock?: WorkItemExecutionLock | null;
}

export interface WorkItemCollabLock {
  /** True when the lock is held by a different org member than us. */
  isLockedByOther: boolean;
  /** Display name of the other holder (falls back to the raw id). */
  lockHolderName: string | null;
  /** Whether the work item is under a cloud-synced org at all. */
  isCollabWorkItem: boolean;
  /**
   * Acquire the server lock before starting. Resolves `false` for non-cloud
   * work items (proceed locally). Rejects with `ORG2_CONFLICT` when a
   * teammate holds the lock, and with `CollabMembershipUnresolvedError` when
   * collab membership cannot be resolved (the caller must block the start —
   * see the error's doc).
   */
  acquireLock: () => Promise<boolean>;
  /** Release the server lock when the session terminates (best-effort). */
  releaseLock: () => Promise<void>;
}

export function useWorkItemCollabLock(
  options: UseWorkItemCollabLockOptions
): WorkItemCollabLock {
  const { projectSlug, shortId, workItemId, executionLock } = options;
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const [resolution, setResolution] = useState<CollabOrgResolution>(UNRESOLVED);

  // Resolve the project's org id per project — and keep it fresh: the
  // watcher re-probes whenever `org2CloudOrgsAtom` changes, so a resolution
  // computed against the not-yet-hydrated (or since-refetched) cloud orgs
  // atom is corrected instead of frozen for the lifetime of the view (a
  // frozen `cloudOrgId: null` would silently skip cloud lock arbitration).
  // Only sets state after an await / through a microtask, so the effect
  // never mutates state synchronously (react-hooks/set-state-in-effect). A
  // readProject FAILURE keeps the "unresolved" state — it must not degrade
  // to "resolved: not collab", or acquireLock would skip server arbitration
  // on a transient error; acquireLock retries the read instead.
  useEffect(() => {
    let cancelled = false;
    if (!projectSlug) {
      // No project ⇒ standalone work item ⇒ provably not cloud-synced.
      queueMicrotask(() => {
        if (!cancelled) {
          setResolution({
            status: "resolved",
            projectOrgId: null,
            cloudOrgId: null,
          });
        }
      });
      return () => {
        cancelled = true;
      };
    }
    queueMicrotask(() => {
      if (!cancelled) setResolution(UNRESOLVED);
    });
    const unwatch = watchCollabOrgResolution(projectSlug, (resolved) => {
      if (!cancelled) setResolution(resolved);
    });
    return () => {
      cancelled = true;
      unwatch();
    };
  }, [projectSlug]);

  const cloudOrgId =
    resolution.status === "resolved" ? resolution.cloudOrgId : null;

  const localMemberId = cloudOrgId ? cloudAuth?.userId : undefined;

  const memberNames = useAtomValue(org2CloudMemberNamesAtom);
  const lockedByMemberId = executionLock?.lockedByMemberId;

  useEffect(() => {
    if (!cloudOrgId || !lockedByMemberId) return;
    if (lockedByMemberId === localMemberId) return;
    void ensureCloudMemberNames(cloudOrgId);
  }, [cloudOrgId, lockedByMemberId, localMemberId]);

  const holderDisplayName =
    cloudOrgId && lockedByMemberId
      ? resolveCloudMemberName(memberNames, cloudOrgId, lockedByMemberId)
      : null;

  const holder = useMemo(
    () => resolveLockHolder(lockedByMemberId, localMemberId, holderDisplayName),
    [lockedByMemberId, localMemberId, holderDisplayName]
  );

  const acquireLock = useMemo(
    () => async (): Promise<boolean> => {
      if (!projectSlug || !workItemId) return false;
      if (resolution.status !== "resolved") {
        // The resolve effect failed (or has not finished): retry inline. If
        // the project org STILL cannot be read we must block the start —
        // only a provably-not-cloud work item may run without arbitration.
        // The cloud-alias probe is part of the same resolution (its failure
        // equally blocks the start).
        try {
          const project = await projectApi.readProject(projectSlug);
          const effectiveCloudOrgId = await resolveCloudOrgForProjectOrg(
            project.meta.org_id
          );
          if (
            effectiveCloudOrgId === null &&
            (await isCloudOrgMembershipPending(project.meta.org_id))
          ) {
            // Signed in with the cloud-orgs roster still loading: we cannot
            // prove this work item is NOT cloud-synced, so block rather than
            // start without server arbitration (same discipline as a
            // readProject failure). The roster lands within ~1s of app start.
            throw new CollabMembershipUnresolvedError(projectSlug);
          }
          setResolution({
            status: "resolved",
            projectOrgId: project.meta.org_id,
            cloudOrgId: effectiveCloudOrgId,
          });
        } catch (error) {
          if (isCollabMembershipUnresolvedError(error)) throw error;
          logger.warn(
            "collab membership still unresolved at acquire time",
            error
          );
          throw new CollabMembershipUnresolvedError(projectSlug);
        }
      }
      // acquireCloudWorkItemLock resolves the cloud alias itself and returns
      // false for non-cloud work items (proceed without a server lock).
      return acquireCloudWorkItemLock(projectSlug, workItemId, {
        activeShortId: shortId ?? undefined,
      });
    },
    [projectSlug, resolution, workItemId, shortId]
  );

  const releaseLock = useMemo(
    () => async (): Promise<void> => {
      // Best-effort by design: a non-cloud work item is a no-op, and any
      // failure is swallowed (the row still syncs, and the server-side lock
      // is idempotently overwritten by the next acquirer).
      if (!projectSlug || !workItemId) return;
      try {
        await releaseCloudWorkItemLock(projectSlug, workItemId);
      } catch {
        // Offline / already released / signed out: the payload sync path
        // still reconciles the lock; nothing actionable to surface here.
      }
    },
    [projectSlug, workItemId]
  );

  return {
    isLockedByOther: holder.heldByOther,
    lockHolderName: holder.holderName,
    isCollabWorkItem: Boolean(cloudOrgId),
    acquireLock,
    releaseLock,
  };
}
