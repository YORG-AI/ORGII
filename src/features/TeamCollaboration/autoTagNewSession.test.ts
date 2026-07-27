import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import { org2CloudSyncEngine } from "@src/features/Org2Cloud/org2CloudSyncEngine";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { autoTagLaunchedSessionToActiveCloudOrg } from "./autoTagNewSession";
import {
  resolveMatchingOrgRepoScope,
  resolveShareableScopeKeys,
} from "./repoScopeResolver";
import { sessionOrgTagsAtom, tokensForSession } from "./sessionOrgTagsAtom";

vi.mock("./repoScopeResolver", () => ({
  resolveShareableScopeKeys: vi.fn(async () => []),
  resolveMatchingOrgRepoScope: vi.fn(
    async (keys: string[] | null, scopes: string[] | undefined) =>
      scopes?.find((scope) => keys?.includes(scope)) ?? null
  ),
}));

vi.mock("@src/features/Org2Cloud/org2CloudSyncEngine", () => ({
  org2CloudSyncEngine: {
    runSyncPassAndWaitForDrain: vi.fn(async () => undefined),
  },
}));

const resolveScopeKeysMock = vi.mocked(resolveShareableScopeKeys);
const resolveMatchingScopeMock = vi.mocked(resolveMatchingOrgRepoScope);
const syncPassMock = vi.mocked(org2CloudSyncEngine.runSyncPassAndWaitForDrain);

const store = createInstrumentedStore();

const ORG_ID = "org-1";
const SCOPE_KEY = "github.com/acme/repo";

function seedCloudScope() {
  store.set(sidebarActiveCloudOrgIdAtom, ORG_ID);
  store.set(org2CloudOrgsAtom, [
    { orgId: ORG_ID, name: "Acme", role: "member" },
  ]);
  store.set(org2CloudRepoScopesAtom, { [ORG_ID]: [SCOPE_KEY] });
  resolveScopeKeysMock.mockResolvedValue([SCOPE_KEY]);
}

describe("autoTagLaunchedSessionToActiveCloudOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.set(sessionOrgTagsAtom, {});
    store.set(sidebarActiveCloudOrgIdAtom, null);
    store.set(org2CloudOrgsAtom, []);
    store.set(org2CloudRepoScopesAtom, {});
    resolveScopeKeysMock.mockResolvedValue([]);
    resolveMatchingScopeMock.mockImplementation(
      async (keys, scopes) =>
        scopes?.find((scope) => keys?.includes(scope)) ?? null
    );
    syncPassMock.mockResolvedValue(undefined);
  });

  it("tags the new session into the active cloud org and triggers a sync pass", async () => {
    seedCloudScope();

    const tagged = await autoTagLaunchedSessionToActiveCloudOrg({
      sessionId: "session-1",
      repoPath: "/repo/acme",
      launchOrgId: null,
    });

    expect(tagged).toBe(true);
    expect(
      tokensForSession(store.get(sessionOrgTagsAtom), "session-1")
    ).toEqual([`cloud:${ORG_ID}`]);
    expect(syncPassMock).toHaveBeenCalledTimes(1);
  });

  it("tags when the launch context carries the default personal org", async () => {
    seedCloudScope();

    const tagged = await autoTagLaunchedSessionToActiveCloudOrg({
      sessionId: "session-1",
      repoPath: "/repo/acme",
      launchOrgId: "personal-org",
    });

    expect(tagged).toBe(true);
  });

  it("tags when differently named GitHub forks resolve to one upstream", async () => {
    seedCloudScope();
    resolveScopeKeysMock.mockResolvedValue(["github.com/org2ai/org2"]);
    resolveMatchingScopeMock.mockResolvedValue("github.com/vantanode/org2");

    const tagged = await autoTagLaunchedSessionToActiveCloudOrg({
      sessionId: "session-fork-network",
      repoPath: "/repo/org2",
      launchOrgId: null,
    });

    expect(tagged).toBe(true);
  });

  it("skips when the creator explicitly chose a different org", async () => {
    seedCloudScope();

    const tagged = await autoTagLaunchedSessionToActiveCloudOrg({
      sessionId: "session-1",
      repoPath: "/repo/acme",
      launchOrgId: "project-org-7",
    });

    expect(tagged).toBe(false);
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
    expect(syncPassMock).not.toHaveBeenCalled();
  });

  it("skips when no cloud org scope is active in the sidebar", async () => {
    seedCloudScope();
    store.set(sidebarActiveCloudOrgIdAtom, null);

    const tagged = await autoTagLaunchedSessionToActiveCloudOrg({
      sessionId: "session-1",
      repoPath: "/repo/acme",
      launchOrgId: null,
    });

    expect(tagged).toBe(false);
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
  });

  it("skips when the session repo is outside the org's repo scopes", async () => {
    seedCloudScope();
    resolveScopeKeysMock.mockResolvedValue(["github.com/other/repo"]);

    const tagged = await autoTagLaunchedSessionToActiveCloudOrg({
      sessionId: "session-1",
      repoPath: "/repo/other",
      launchOrgId: null,
    });

    expect(tagged).toBe(false);
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
    expect(syncPassMock).not.toHaveBeenCalled();
  });

  it("skips when the session has no repo path", async () => {
    seedCloudScope();

    const tagged = await autoTagLaunchedSessionToActiveCloudOrg({
      sessionId: "session-1",
      repoPath: null,
      launchOrgId: null,
    });

    expect(tagged).toBe(false);
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
  });

  it("skips when the active scope org is no longer in the cloud org roster", async () => {
    seedCloudScope();
    store.set(org2CloudOrgsAtom, []);

    const tagged = await autoTagLaunchedSessionToActiveCloudOrg({
      sessionId: "session-1",
      repoPath: "/repo/acme",
      launchOrgId: null,
    });

    expect(tagged).toBe(false);
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
  });
});
