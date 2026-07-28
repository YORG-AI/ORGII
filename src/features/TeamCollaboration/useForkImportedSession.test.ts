import { describe, expect, it, vi } from "vitest";

import { ORG2_CLOUD_OFFICIAL_SUPABASE_URL } from "@src/features/Org2Cloud/config";
import type { Org2CloudOrg } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { COLLAB_IDENTITY_KIND } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  executeAuthenticatedCloudSessionFork,
  pickCloudRemoteSession,
} from "./cloudSessionFork";
import type {
  ForkSessionResult,
  ForkTeammateSessionOptions,
} from "./forkSession";
import {
  executeGuestShareFork,
  resolveImportedSessionForkBackend,
} from "./useForkImportedSession";

const IMPORTED_FROM = {
  orgId: "org-1",
  sourceSessionId: "remote-1",
  ownerMemberId: "m2",
};

function makeCloudOrg(overrides: Partial<Org2CloudOrg> = {}): Org2CloudOrg {
  return { orgId: "org-1", name: "Cloud Org", role: "member", ...overrides };
}

function makeRemote(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id: "org-1:m2:remote-1",
    orgId: "org-1",
    ownerMemberId: "m2",
    ownerUserId: "m2",
    ownerDisplayName: "Bob",
    ownerIdentityKind: COLLAB_IDENTITY_KIND.HUMAN,
    sourceSessionId: "remote-1",
    title: "Remote session",
    repoPath: "/repo/shared",
    eventsEpoch: 1,
    eventsFrozenSeq: 1,
    eventsCount: 4,
    eventsTailHash: "hash",
    ...overrides,
  };
}

describe("pickCloudRemoteSession", () => {
  it("matches on orgId + sourceSessionId", () => {
    const rows = [
      makeRemote({ orgId: "other-org", id: "other-org:m2:remote-1" }),
      makeRemote({ sourceSessionId: "remote-9", id: "org-1:m2:remote-9" }),
      makeRemote(),
    ];
    expect(pickCloudRemoteSession(rows, IMPORTED_FROM)).toBe(rows[2]);
  });

  it("skips tombstoned rows", () => {
    const rows = [makeRemote({ deletedAt: "2026-07-02T00:00:00.000Z" })];
    expect(pickCloudRemoteSession(rows, IMPORTED_FROM)).toBeUndefined();
  });
});

describe("resolveImportedSessionForkBackend", () => {
  it("resolves to cloud when the org id is a signed-in cloud org", () => {
    const resolution = resolveImportedSessionForkBackend(IMPORTED_FROM, [
      makeCloudOrg(),
    ]);
    expect(resolution).toEqual({ kind: "cloud", orgId: "org-1" });
  });

  it("is 'generic' when no signed-in cloud org matches (left org / signed out)", () => {
    expect(resolveImportedSessionForkBackend(IMPORTED_FROM, [])).toEqual({
      kind: "unavailable",
      errorKind: "generic",
    });
    expect(
      resolveImportedSessionForkBackend(IMPORTED_FROM, [
        makeCloudOrg({ orgId: "cloud-other" }),
      ])
    ).toEqual({ kind: "unavailable", errorKind: "generic" });
  });

  it("uses a persisted share token when the importer is not a member", () => {
    expect(
      resolveImportedSessionForkBackend(
        {
          ...IMPORTED_FROM,
          shareToken: "tok-1",
          shareEndpointUrl: "https://cloud.example.com",
        },
        []
      )
    ).toEqual({
      kind: "guestShare",
      shareToken: "tok-1",
      shareEndpointUrl: "https://cloud.example.com",
    });
  });

  it("prefers membership over a persisted share token", () => {
    expect(
      resolveImportedSessionForkBackend(
        { ...IMPORTED_FROM, shareToken: "tok-1" },
        [makeCloudOrg()]
      )
    ).toEqual({ kind: "cloud", orgId: "org-1" });
  });

  it("does not treat an empty share token as a credential", () => {
    expect(
      resolveImportedSessionForkBackend(
        { ...IMPORTED_FROM, shareToken: "" },
        []
      )
    ).toEqual({ kind: "unavailable", errorKind: "generic" });
  });
});

describe("executeGuestShareFork", () => {
  const result: ForkSessionResult = {
    localSessionId: "agentsession-guest-fork",
    name: "⑂ Remote session",
    eventCount: 4,
  };

  function makeDeps() {
    const client = { getSessionEventSegments: vi.fn() };
    const fork = vi.fn<
      (options: ForkTeammateSessionOptions) => Promise<ForkSessionResult | null>
    >(async () => result);
    return {
      client,
      deps: {
        resolveShare: vi.fn(async () => makeRemote()),
        buildClient: vi.fn(() => client),
        fork,
      },
    };
  }

  it("forks with a registered-user client and the share token", async () => {
    const { client, deps } = makeDeps();

    await expect(
      executeGuestShareFork(
        "jwt-non-member",
        "tok-1",
        ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
        deps
      )
    ).resolves.toEqual(result);
    expect(deps.resolveShare).toHaveBeenCalledWith(
      "jwt-non-member",
      "tok-1",
      expect.objectContaining({
        isOfficial: true,
        supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
      })
    );
    expect(deps.buildClient).toHaveBeenCalledWith(
      "jwt-non-member",
      expect.objectContaining({
        isOfficial: true,
        supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
      })
    );
    expect(deps.fork).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        shareToken: "tok-1",
        orgId: "org-1",
      })
    );
  });

  it("propagates a revoked share without attempting a fork", async () => {
    const { deps } = makeDeps();
    deps.resolveShare.mockRejectedValueOnce(new Error("ORG2_UNAUTHORIZED"));
    await expect(
      executeGuestShareFork("jwt-non-member", "tok-1", undefined, deps)
    ).rejects.toThrow("ORG2_UNAUTHORIZED");
    expect(deps.fork).not.toHaveBeenCalled();
  });
});

describe("executeAuthenticatedCloudSessionFork", () => {
  const result: ForkSessionResult = {
    localSessionId: "agentsession-member-fork",
    name: "⑂ Remote session",
    eventCount: 4,
  };

  function makeDeps(rows: RemoteTeammateSessionMetadata[]) {
    const client = { getSessionEventSegments: vi.fn() };
    const fork = vi.fn<
      (options: ForkTeammateSessionOptions) => Promise<ForkSessionResult | null>
    >(async () => result);
    return {
      client,
      deps: {
        listSessions: vi.fn(async () => ({ sessions: rows })),
        buildClient: vi.fn(() => client),
        fork,
      },
    };
  }

  it("uses the member client and the canonical fork setup path", async () => {
    const { client, deps } = makeDeps([makeRemote()]);
    await expect(
      executeAuthenticatedCloudSessionFork(
        "jwt-1",
        { orgId: "org-1", sourceSessionId: "remote-1" },
        deps
      )
    ).resolves.toEqual({ status: "forked", result });
    expect(deps.listSessions).toHaveBeenCalledWith("jwt-1", "org-1");
    expect(deps.buildClient).toHaveBeenCalledWith("jwt-1");
    expect(deps.fork).toHaveBeenCalledWith({
      client,
      orgId: "org-1",
      remoteSession: expect.objectContaining({ sourceSessionId: "remote-1" }),
      promptForExecution: true,
    });
  });

  it("reports a retained/revoked source as gone before forking", async () => {
    const { deps } = makeDeps([]);
    await expect(
      executeAuthenticatedCloudSessionFork(
        "jwt-1",
        { orgId: "org-1", sourceSessionId: "remote-1" },
        deps
      )
    ).resolves.toEqual({ status: "gone" });
    expect(deps.fork).not.toHaveBeenCalled();
  });
});
