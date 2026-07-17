import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  getCloudEndpoint,
} from "./config";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { org2CloudCommentTasksAtom } from "./org2CloudCommentTasksAtom";
import {
  org2CloudEndpointOverrideAtom,
  resetCloudStateForEndpointSwitch,
} from "./org2CloudEndpointAtom";
import { org2CloudOrgsAtom } from "./org2CloudOrgsAtom";
import { org2CloudRemoteSessionsAtom } from "./org2CloudRemoteSessionsAtom";
import { org2CloudSessionCommentsAtom } from "./org2CloudSessionCommentsAtom";
import {
  org2CloudCollabStateCursorsAtom,
  org2CloudCommentTaskCursorsAtom,
  org2CloudPushCursorsAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://old.supabase.co",
  supabaseAnonKey: "anon-old",
  userId: "user-1",
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 1751500000,
};

const OVERRIDE = {
  webOrigin: "https://cloud.acme.dev",
  supabaseUrl: "https://supabase.acme.dev",
  anonKey: "sb_publishable_custom",
};

describe("org2CloudEndpointOverrideAtom", () => {
  beforeEach(() => {
    localStorage.removeItem(ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY);
  });

  it("writes through the key getCloudEndpoint() reads (no reload needed)", () => {
    const store = createStore();
    store.set(org2CloudEndpointOverrideAtom, OVERRIDE);
    expect(getCloudEndpoint()).toEqual({ ...OVERRIDE, isOfficial: false });
    store.set(org2CloudEndpointOverrideAtom, null);
    expect(getCloudEndpoint().isOfficial).toBe(true);
  });
});

describe("resetCloudStateForEndpointSwitch", () => {
  it("signs out and wipes orgs, scopes, and every cursor atom", () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, { "corg-1": ["github.com/acme/a"] });
    store.set(org2CloudSyncEnabledAtom, { "corg-1": false });
    store.set(org2CloudPushCursorsAtom, {
      "corg-1:session-1": {
        orgId: "corg-1",
        sessionId: "session-1",
        epoch: 1,
        frozenSeq: 2,
        pushedCount: 3,
        frozenEventCount: 2,
        frozenChainHash: "hash",
        tailHash: null,
      },
    });
    store.set(org2CloudCollabStateCursorsAtom, {
      "corg-1": "2026-07-01T00:00:00.000Z",
    });
    // Comment agent tasks (0002): persisted delta cursor + in-memory
    // task/comment caches are old-backend state too.
    store.set(org2CloudCommentTaskCursorsAtom, {
      "corg-1": "2026-07-01T00:00:00.000Z",
    });
    store.set(org2CloudCommentTasksAtom, {
      "corg-1": {
        "task-1": {
          id: "task-1",
          sessionId: "session-1",
          commentId: "comment-1",
          state: "open",
          leaseExpired: false,
          attempt: 0,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      },
    });
    store.set(org2CloudSessionCommentsAtom, {
      "corg-1|session-1": {
        comments: [],
        tasks: [],
        state: "ready",
        fetchedAt: 1,
      },
    });
    store.set(org2CloudRemoteSessionsAtom, {
      "corg-1": { rows: [], state: "ready", fetchedAt: 1 },
    });

    resetCloudStateForEndpointSwitch(store);

    expect(store.get(org2CloudAuthAtom)).toBeNull();
    expect(store.get(org2CloudOrgsAtom)).toEqual([]);
    expect(store.get(org2CloudRepoScopesAtom)).toEqual({});
    expect(store.get(org2CloudSyncEnabledAtom)).toEqual({});
    expect(store.get(org2CloudPushCursorsAtom)).toEqual({});
    expect(store.get(org2CloudCollabStateCursorsAtom)).toEqual({});
    expect(store.get(org2CloudCommentTaskCursorsAtom)).toEqual({});
    expect(store.get(org2CloudCommentTasksAtom)).toEqual({});
    expect(store.get(org2CloudSessionCommentsAtom)).toEqual({});
    expect(store.get(org2CloudRemoteSessionsAtom)).toEqual({});
  });

  it("does not touch the endpoint override itself", () => {
    const store = createStore();
    store.set(org2CloudEndpointOverrideAtom, OVERRIDE);
    resetCloudStateForEndpointSwitch(store);
    expect(store.get(org2CloudEndpointOverrideAtom)).toEqual(OVERRIDE);
    store.set(org2CloudEndpointOverrideAtom, null);
  });
});
