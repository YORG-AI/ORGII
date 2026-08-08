// @vitest-environment jsdom
import { getDefaultStore } from "jotai";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
} from "@src/features/Org2Cloud/org2CloudAccessSettings";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
} from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import { resetSyncJournalForTests } from "@src/features/Org2Cloud/org2CloudSyncJournal";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import type { CloudOrgSyncStatus } from "./useCloudOrgSyncStatus";
import {
  loadCompleteCoverageRoster,
  useCloudOrgSyncStatus,
} from "./useCloudOrgSyncStatus";

const mocks = vi.hoisted(() => ({
  runSyncPassAndWaitForDrain: vi.fn<() => Promise<void>>(),
  schemaVersion: vi.fn<() => Promise<number | null>>(),
  getCloudCapabilities: vi.fn(),
  endpointForOrg: vi.fn(),
  sessionAggregateList: vi.fn(),
  toFrontendSessions: vi.fn((sessions: unknown[]) => sessions),
}));

vi.mock("@src/api/tauri/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/session")>()),
  sessionAggregateList: mocks.sessionAggregateList,
  toFrontendSessions: mocks.toFrontendSessions,
}));

vi.mock("@src/features/Org2Cloud/org2CloudSyncEngine", () => ({
  org2CloudSyncEngine: {
    runSyncPassAndWaitForDrain: mocks.runSyncPassAndWaitForDrain,
  },
}));

vi.mock("@src/features/Org2Cloud/org2CloudClient", () => ({
  schemaVersion: mocks.schemaVersion,
}));

vi.mock("@src/features/Org2Cloud/org2CloudCapabilities", () => ({
  getCloudCapabilities: mocks.getCloudCapabilities,
}));

vi.mock("@src/features/Org2Cloud/org2CloudOrgEndpointRouter", () => ({
  endpointForOrg: mocks.endpointForOrg,
}));

function mountStatus(): {
  read: () => CloudOrgSyncStatus;
  root: ReturnType<typeof createSmokeRoot>;
  mount: () => Promise<void>;
} {
  // Append rather than reassign: every render records its status object and
  // `read()` takes the newest one.
  const readings: CloudOrgSyncStatus[] = [];
  function Probe() {
    readings.push(useCloudOrgSyncStatus("org-1"));
    return null;
  }
  const root = createSmokeRoot();
  return {
    root,
    mount: () => root.render(createElement(Probe)),
    read: () => {
      const latest = readings[readings.length - 1];
      if (!latest) throw new Error("probe not mounted");
      return latest;
    },
  };
}

beforeEach(() => {
  resetSyncJournalForTests();
  mocks.runSyncPassAndWaitForDrain.mockReset();
  mocks.runSyncPassAndWaitForDrain.mockResolvedValue(undefined);
  mocks.schemaVersion.mockReset();
  mocks.schemaVersion.mockResolvedValue(1);
  mocks.getCloudCapabilities.mockReset();
  mocks.getCloudCapabilities.mockResolvedValue({
    broadcastSignals: true,
    storageSegments: true,
    homeEndpoints: false,
    teamInboxMentions: false,
    memberRuntime: true,
  });
  mocks.endpointForOrg.mockReset();
  mocks.endpointForOrg.mockReturnValue({
    webOrigin: "https://app.example.com",
    supabaseUrl: "https://db.example.com/",
    anonKey: "super-secret-anon-key",
    isOfficial: true,
  });
  mocks.sessionAggregateList.mockReset();
  mocks.sessionAggregateList.mockImplementation(async () => ({
    sessions: getDefaultStore().get(sessionsAtom),
  }));
  mocks.toFrontendSessions.mockClear();
  getDefaultStore().set(org2CloudSharingFloorAtom, {
    "org-1": "metadata_only",
  });
});

afterEach(() => {
  resetSyncJournalForTests();
  const store = getDefaultStore();
  store.set(sessionsAtom, []);
  store.set(org2CloudPushedMetadataAtom, {});
  store.set(org2CloudPushCursorsAtom, {});
  store.set(org2CloudRepoScopesAtom, {});
  store.set(org2CloudAccessSettingsAtom, {});
  store.set(org2CloudSharingFloorAtom, {});
});

/**
 * `repoPath` is written as a remote-style scope key on purpose: the resolver
 * short-circuits those to themselves, so grouping is synchronous here instead
 * of waiting on a real git-remote lookup.
 */
function localSession(
  session_id: string,
  overrides: Partial<Session> = {}
): Session {
  return {
    session_id,
    orgId: "cloud:org-1",
    ...overrides,
  } as Session;
}

describe("useCloudOrgSyncStatus", () => {
  it("reads every bounded aggregate page instead of the UI roster page", async () => {
    const all = Array.from({ length: 201 }, (_, index) =>
      localSession(`session-${index}`)
    );
    const loadPage = vi.fn(async (filter: { offset?: number }) => ({
      sessions: filter.offset === 0 ? all.slice(0, 200) : all.slice(200),
    }));

    const loaded = await loadCompleteCoverageRoster(
      {
        includeExternalHistory: true,
        disabledExternalHistorySources: ["cursor"],
      },
      loadPage as never
    );

    expect(loaded).toHaveLength(201);
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(loadPage.mock.calls[0]?.[0]).toMatchObject({
      limit: 200,
      offset: 0,
      includeExternalHistory: true,
      disabledExternalHistorySources: ["cursor"],
    });
    expect(loadPage.mock.calls[1]?.[0]).toMatchObject({
      limit: 200,
      offset: 200,
    });
  });

  it("marks coverage unavailable when the authoritative roster read fails", async () => {
    mocks.sessionAggregateList.mockRejectedValueOnce(new Error("offline"));
    const probe = mountStatus();
    try {
      await probe.mount();
      expect(probe.read().coverageLoading).toBe(false);
      expect(probe.read().coverageUnavailable).toBe(true);
      expect(probe.read().coverage.syncable).toBe(0);
    } finally {
      await probe.root.unmount();
    }
  });

  it("exposes the backend kind but never the endpoint URL or the anon key", async () => {
    const probe = mountStatus();
    try {
      await probe.mount();
      expect(probe.read().isOfficialEndpoint).toBe(true);
      // Neither the host nor the key may reach the UI layer at all.
      const serialized = JSON.stringify(probe.read());
      expect(serialized).not.toContain("db.example.com");
      expect(serialized).not.toContain("super-secret-anon-key");
    } finally {
      await probe.root.unmount();
    }
  });

  it("probes the schema version once on mount and reports a match", async () => {
    const probe = mountStatus();
    try {
      await probe.mount();
      expect(mocks.schemaVersion).toHaveBeenCalledTimes(1);
      expect(probe.read().schemaStatus).toBe("matched");
      expect(probe.read().backendSchemaVersion).toBe(1);
    } finally {
      await probe.root.unmount();
    }
  });

  it("reports a mismatch when the backend answers a different version", async () => {
    mocks.schemaVersion.mockResolvedValue(7);
    const probe = mountStatus();
    try {
      await probe.mount();
      expect(probe.read().schemaStatus).toBe("mismatched");
      expect(probe.read().backendSchemaVersion).toBe(7);
    } finally {
      await probe.root.unmount();
    }
  });

  it("reports unknown when the probe answers null or rejects", async () => {
    mocks.schemaVersion.mockResolvedValue(null);
    const nullProbe = mountStatus();
    try {
      await nullProbe.mount();
      expect(nullProbe.read().schemaStatus).toBe("unknown");
    } finally {
      await nullProbe.root.unmount();
    }

    mocks.schemaVersion.mockRejectedValue(new Error("offline"));
    const rejectedProbe = mountStatus();
    try {
      await rejectedProbe.mount();
      expect(rejectedProbe.read().schemaStatus).toBe("unknown");
    } finally {
      await rejectedProbe.root.unmount();
    }
  });

  it("stays signed out and skips the capability probe without a token", async () => {
    const probe = mountStatus();
    try {
      await probe.mount();
      expect(probe.read().signedIn).toBe(false);
      expect(probe.read().userId).toBeNull();
      expect(probe.read().tokenExpiresAtMs).toBeNull();
      expect(probe.read().capabilities).toBeNull();
      expect(probe.read().capabilitiesLoading).toBe(false);
      expect(mocks.getCloudCapabilities).not.toHaveBeenCalled();
    } finally {
      await probe.root.unmount();
    }
  });

  it("groups coverage by the org's repo scopes, one row per repo", async () => {
    const store = getDefaultStore();
    store.set(org2CloudRepoScopesAtom, {
      "org-1": ["github.com/acme/alpha", "github.com/acme/beta"],
    });
    store.set(sessionsAtom, [
      localSession("s1", { repoPath: "github.com/acme/alpha" }),
      localSession("s2", { repoPath: "github.com/acme/alpha" }),
      localSession("s3", { repoPath: "github.com/acme/alpha" }),
      localSession("s4", { repoPath: "github.com/acme/beta" }),
      // Excluded from every denominator: a subagent transcript, a spawned
      // child, and a teammate copy pulled down from an org.
      localSession("s1:subagent:0", { repoPath: "github.com/acme/alpha" }),
      localSession("s5", {
        repoPath: "github.com/acme/alpha",
        parentSessionId: "s1",
      }),
      localSession("s6", {
        repoPath: "github.com/acme/alpha",
        importedFrom: { orgId: "org-1" } as never,
      }),
    ]);
    store.set(org2CloudPushedMetadataAtom, {
      "org-1:s1": true,
      // Another org's marker must not lift this org's number.
      "org-2:s3": true,
    });
    // A segments cursor is push evidence too, on the full_replay rung.
    store.set(org2CloudPushCursorsAtom, {
      "org-1:s2": {
        orgId: "org-1",
        sessionId: "s2",
        epoch: 1,
        frozenSeq: 0,
        pushedCount: 3,
        frozenEventCount: 0,
        frozenChainHash: "",
        tailHash: null,
      },
    });

    const probe = mountStatus();
    try {
      await probe.mount();
      expect(probe.read().coverage).toEqual({
        repos: [
          {
            repoScope: "github.com/acme/alpha",
            syncable: 3,
            synced: 2,
            percent: 67,
          },
          {
            repoScope: "github.com/acme/beta",
            syncable: 1,
            synced: 0,
            percent: 0,
          },
        ],
        syncable: 4,
        synced: 2,
        percent: 50,
      });
    } finally {
      await probe.root.unmount();
    }
  });

  it("omits repos the org has not scoped, and their sessions", async () => {
    const store = getDefaultStore();
    store.set(org2CloudRepoScopesAtom, { "org-1": ["github.com/acme/alpha"] });
    store.set(sessionsAtom, [
      localSession("s1", { repoPath: "github.com/acme/alpha" }),
      // Neither of these can ever reach this org — no row, and no drag on the
      // headline percentage.
      localSession("s2", { repoPath: "github.com/me/side-project" }),
      localSession("s3"),
    ]);
    store.set(org2CloudPushedMetadataAtom, { "org-1:s1": true });

    const probe = mountStatus();
    try {
      await probe.mount();
      expect(probe.read().coverage).toEqual({
        repos: [
          {
            repoScope: "github.com/acme/alpha",
            syncable: 1,
            synced: 1,
            percent: 100,
          },
        ],
        syncable: 1,
        synced: 1,
        percent: 100,
      });
    } finally {
      await probe.root.unmount();
    }
  });

  it("reports an empty coverage state when the org has no repo scopes", async () => {
    const store = getDefaultStore();
    store.set(sessionsAtom, [
      localSession("s1", { repoPath: "github.com/acme/alpha" }),
    ]);

    const probe = mountStatus();
    try {
      await probe.mount();
      expect(probe.read().coverage).toEqual({
        repos: [],
        syncable: 0,
        synced: 0,
        percent: null,
      });
    } finally {
      await probe.root.unmount();
    }
  });

  it("runs the engine's drain-waiting pass and reports success", async () => {
    const probe = mountStatus();
    try {
      await probe.mount();
      await dispatch(() => probe.read().runSync());
      expect(mocks.runSyncPassAndWaitForDrain).toHaveBeenCalledTimes(1);
      expect(probe.read().running).toBe(false);
      expect(probe.read().runSucceeded).toBe(true);
      expect(probe.read().runError).toBeNull();
    } finally {
      await probe.root.unmount();
    }
  });

  it("swallows an engine rejection into runError instead of throwing", async () => {
    mocks.runSyncPassAndWaitForDrain.mockRejectedValue(
      Object.assign(new Error("quota gone"), { code: "ORG2_QUOTA_EXCEEDED" })
    );
    const probe = mountStatus();
    try {
      await probe.mount();
      await dispatch(() => {
        expect(() => probe.read().runSync()).not.toThrow();
      });
      expect(mocks.runSyncPassAndWaitForDrain).toHaveBeenCalledTimes(1);
      expect(probe.read().running).toBe(false);
      expect(probe.read().runSucceeded).toBe(false);
      expect(probe.read().runError).toBe("quota gone");
    } finally {
      await probe.root.unmount();
    }
  });
});
