import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import type { CloudPushAccess } from "./org2CloudAccessSettings";
import { Org2CloudSessionSync } from "./org2CloudSessionSync";
import { buildCloudSessionMetadata } from "./org2CloudSessionSync.metadata";
import type { Org2CloudSyncClientDeps } from "./org2CloudSessionSync.types";
import { AUTH, SCOPE_KEY, SESSION } from "./org2CloudSyncEngine.testUtils";

const ORG_ID = "corg-1";

const ACCESS: CloudPushAccess = {
  accessMode: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
  visibility: "org",
};

function makeSeedClient() {
  return {
    upsertSessionMetadata: vi.fn(async () => {}),
    appendSessionEvents: vi.fn(async () => {}),
    rewriteSessionEvents: vi.fn(async () => {}),
    getSessionEvents: vi.fn(async () => ({ events: [], epoch: 0 })),
    getOrgRepoScopes: vi.fn(async () => ({ repoScopes: [] })),
    listOrgSessions: vi.fn(async () => ({ sessions: [] })),
    deleteSession: vi.fn(async () => {}),
  } as unknown as Org2CloudSyncClientDeps & {
    upsertSessionMetadata: ReturnType<typeof vi.fn>;
  };
}

function matchingRemoteSummary() {
  const displayName = AUTH.profile?.displayName ?? AUTH.userId;
  return buildCloudSessionMetadata(
    SESSION,
    ORG_ID,
    AUTH.userId,
    displayName,
    SCOPE_KEY,
    ACCESS,
    AUTH.profile?.avatarUrl
  );
}

describe("Org2CloudSessionSync seedFromRemoteSummary", () => {
  it("suppresses the first metadata upsert after seeding from a matching summary", async () => {
    const client = makeSeedClient();
    const sync = new Org2CloudSessionSync(() => createStore(), client);

    await sync.seedFromRemoteSummary(
      AUTH,
      ORG_ID,
      SESSION,
      SCOPE_KEY,
      ACCESS,
      matchingRemoteSummary()
    );
    await sync.pushSession(AUTH, ORG_ID, SESSION, SCOPE_KEY, ACCESS);

    expect(client.upsertSessionMetadata).not.toHaveBeenCalled();
  });

  it("still upserts when the remote summary does not match the local payload", async () => {
    const client = makeSeedClient();
    const sync = new Org2CloudSessionSync(() => createStore(), client);

    await sync.seedFromRemoteSummary(AUTH, ORG_ID, SESSION, SCOPE_KEY, ACCESS, {
      ...matchingRemoteSummary(),
      title: "Renamed elsewhere",
    });
    await sync.pushSession(AUTH, ORG_ID, SESSION, SCOPE_KEY, ACCESS);

    expect(client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
  });
});
