/**
 * Regression coverage for the cloud-alias resolution of
 * `useWorkItemCollabLock` (cloud-parity Phase B).
 *
 * The bug this pins down: the hook used to probe
 * `resolveCloudOrgForProjectOrg` exactly once per project. That resolver
 * gates on membership in `org2CloudOrgsAtom`, which is in-memory only and
 * populated ASYNCHRONOUSLY after sign-in / app start — so a probe that ran
 * before `listMyOrgs` landed cached `cloudOrgId: null` forever, and a
 * genuinely cloud-synced work item silently lost server lock arbitration
 * (two members could double-start it). `watchCollabOrgResolution` — the
 * framework-free core the hook's effect binds to (the node vitest env has
 * no hook-render harness) — must re-probe on every atom change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectApi } from "@src/api/http/project";
import type { ProjectData } from "@src/api/http/project";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  createInstrumentedStore,
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import type { ResolvedCollabOrgResolution } from "./useWorkItemCollabLock";
import {
  getSharedCollabResolutionWatchCount,
  resolveLockHolder,
  watchCollabOrgResolution,
} from "./useWorkItemCollabLock";

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readProject: vi.fn(),
    readOrgs: vi.fn(),
  },
}));

// Keep the import graph fetch-free: the lock RPC helpers are exercised by
// their own suite (cloudWorkItemLock tests).
vi.mock("@src/features/Org2Cloud/cloudWorkItemLock", () => ({
  acquireCloudWorkItemLock: vi.fn(),
  releaseCloudWorkItemLock: vi.fn(),
}));

const projectApiMock = vi.mocked(projectApi);

const PROJECT: ProjectData = {
  meta: { org_id: "porg-1" },
} as ProjectData;

/** The durable cloud alias row `resolveCloudOrgForProjectOrg` reads. */
const CLOUD_ALIAS = {
  id: "porg-1",
  name: "Cloud Team",
  slug: "cloud-team",
  org_key: "cloud-team",
  source: "local",
  sync_provider: "orgii_collab",
  external_org_id: "corg-1",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

/** Drain the watcher's probe (two awaits ⇒ a couple of macrotask turns). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  if (!isStoreInitialized()) createInstrumentedStore();
  getInstrumentedStore().set(org2CloudOrgsAtom, []);
  projectApiMock.readProject.mockResolvedValue(PROJECT);
  projectApiMock.readOrgs.mockResolvedValue([CLOUD_ALIAS]);
});

afterEach(() => {
  getInstrumentedStore().set(org2CloudOrgsAtom, []);
  vi.clearAllMocks();
});

describe("resolveLockHolder", () => {
  it("returns no holder when the lock is free", () => {
    expect(resolveLockHolder(null, "me")).toEqual({
      heldByOther: false,
      holderName: null,
    });
  });

  it("prefers the roster display name for a teammate holder", () => {
    expect(resolveLockHolder("user-2", "user-1", "Ada Lovelace")).toEqual({
      heldByOther: true,
      holderName: "Ada Lovelace",
    });
  });

  it("falls back to the raw id when the member left the roster", () => {
    expect(resolveLockHolder("user-2", "user-1", null)).toEqual({
      heldByOther: true,
      holderName: "user-2",
    });
  });

  it("treats our own lock as not held by other", () => {
    expect(resolveLockHolder("user-1", "user-1", "Me").heldByOther).toBe(false);
  });
});

describe("watchCollabOrgResolution", () => {
  it("shares one project probe across concurrent detail surfaces", async () => {
    const first: ResolvedCollabOrgResolution[] = [];
    const second: ResolvedCollabOrgResolution[] = [];
    const releaseFirst = watchCollabOrgResolution("proj-shared", (resolution) =>
      first.push(resolution)
    );
    const releaseSecond = watchCollabOrgResolution(
      "proj-shared",
      (resolution) => second.push(resolution)
    );

    await settle();
    expect(projectApiMock.readProject).toHaveBeenCalledOnce();
    expect(first.at(-1)).toEqual(second.at(-1));
    expect(getSharedCollabResolutionWatchCount()).toBe(1);

    releaseFirst();
    expect(getSharedCollabResolutionWatchCount()).toBe(1);
    releaseSecond();
    expect(getSharedCollabResolutionWatchCount()).toBe(0);
  });

  it("re-resolves the cloud alias when org2CloudOrgsAtom hydrates LATE", async () => {
    const resolutions: ResolvedCollabOrgResolution[] = [];
    const unwatch = watchCollabOrgResolution("proj-1", (resolution) =>
      resolutions.push(resolution)
    );

    // App-start race: the local IPC reads win against the in-flight
    // listMyOrgs fetch, so the first probe sees an EMPTY cloud orgs atom.
    await settle();
    expect(resolutions.at(-1)).toEqual({
      status: "resolved",
      projectOrgId: "porg-1",
      cloudOrgId: null,
    });

    // Late hydration lands. Pre-fix this changed nothing (the null was
    // frozen for the lifetime of the view); now the watcher re-probes and
    // the SAME subscriber receives the corrected resolution.
    getInstrumentedStore().set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
    ]);
    await settle();
    expect(resolutions.at(-1)).toEqual({
      status: "resolved",
      projectOrgId: "porg-1",
      cloudOrgId: "corg-1",
    });

    unwatch();
  });

  it("drops the alias again when the atom clears (sign-out)", async () => {
    getInstrumentedStore().set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
    ]);
    const resolutions: ResolvedCollabOrgResolution[] = [];
    const unwatch = watchCollabOrgResolution("proj-1", (resolution) =>
      resolutions.push(resolution)
    );
    await settle();
    expect(resolutions.at(-1)?.cloudOrgId).toBe("corg-1");

    getInstrumentedStore().set(org2CloudOrgsAtom, []);
    await settle();
    // Signed out ⇒ the missing-credential residual: proceed-locally.
    expect(resolutions.at(-1)?.cloudOrgId).toBeNull();
    unwatch();
  });

  it("keeps the caller's state on probe failure, then recovers on the next atom change", async () => {
    projectApiMock.readProject.mockRejectedValueOnce(new Error("ipc down"));
    const resolutions: ResolvedCollabOrgResolution[] = [];
    const unwatch = watchCollabOrgResolution("proj-1", (resolution) =>
      resolutions.push(resolution)
    );
    await settle();
    // No emission: the hook stays "unresolved" and acquireLock's inline
    // retry / CollabMembershipUnresolvedError discipline blocks the start.
    expect(resolutions).toEqual([]);

    // Hydration triggers a re-probe with the read healthy again.
    getInstrumentedStore().set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
    ]);
    await settle();
    expect(resolutions.at(-1)).toEqual({
      status: "resolved",
      projectOrgId: "porg-1",
      cloudOrgId: "corg-1",
    });
    unwatch();
  });

  it("stops emitting after unsubscribe", async () => {
    const resolutions: ResolvedCollabOrgResolution[] = [];
    const unwatch = watchCollabOrgResolution("proj-1", (resolution) =>
      resolutions.push(resolution)
    );
    await settle();
    const emitted = resolutions.length;

    unwatch();
    getInstrumentedStore().set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
    ]);
    await settle();
    expect(resolutions.length).toBe(emitted);
  });
});
