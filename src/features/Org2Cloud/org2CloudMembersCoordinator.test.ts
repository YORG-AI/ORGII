import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { ensureFreshSession, listOrgMembers } from "./org2CloudClient";
import {
  MAX_ROSTER_CACHE_ENTRIES,
  clearCloudOrgMembersCache,
  loadCloudOrgMembers,
} from "./org2CloudMembersCoordinator";

vi.mock("./org2CloudClient", () => ({
  ensureFreshSession: vi.fn(),
  listOrgMembers: vi.fn(),
}));

const ensureFreshSessionMock = vi.mocked(ensureFreshSession);
const listOrgMembersMock = vi.mocked(listOrgMembers);
let store = createStore();

function auth(userId = "user-1"): Org2CloudAuthState {
  return {
    kind: "org2_cloud",
    supabaseUrl: "https://cloud.example.com",
    supabaseAnonKey: "anon",
    userId,
    accessToken: `token-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt: 9999999999,
  };
}

beforeEach(() => {
  clearCloudOrgMembersCache();
  store = createStore();
  vi.clearAllMocks();
  ensureFreshSessionMock.mockImplementation(async (current) => current);
  listOrgMembersMock.mockResolvedValue([
    {
      userId: "member-1",
      displayName: "Ada",
      role: "member",
      status: "active",
    },
  ]);
});

describe("loadCloudOrgMembers", () => {
  it("coalesces concurrent consumers and reuses the fresh cache", async () => {
    const current = auth();
    const [first, second] = await Promise.all([
      loadCloudOrgMembers(store, current, "org-1"),
      loadCloudOrgMembers(store, current, "org-1"),
    ]);

    expect(first?.members).toEqual(second?.members);
    await loadCloudOrgMembers(store, current, "org-1");
    expect(listOrgMembersMock).toHaveBeenCalledTimes(1);
  });

  it("refetches after a realtime roster version bump", async () => {
    const current = auth();
    await loadCloudOrgMembers(store, current, "org-1", 3);
    await loadCloudOrgMembers(store, current, "org-1", 4);
    expect(listOrgMembersMock).toHaveBeenCalledTimes(2);
  });

  it("forces a fresh read for the open-panel fallback without duplicating an in-flight request", async () => {
    const current = auth();
    const first = await loadCloudOrgMembers(store, current, "org-1", 0);
    expect(first?.members).toHaveLength(1);

    listOrgMembersMock.mockResolvedValueOnce([
      ...(first?.members ?? []),
      {
        userId: "member-2",
        displayName: "Teammate",
        role: "member",
        status: "active",
      },
    ]);
    const forced = loadCloudOrgMembers(store, current, "org-1", 0, {
      force: true,
    });
    const coalesced = loadCloudOrgMembers(store, current, "org-1", 0, {
      force: true,
    });

    await expect(forced).resolves.toEqual(await coalesced);
    expect(listOrgMembersMock).toHaveBeenCalledTimes(2);
  });

  it("never shares a roster cache across cloud identities", async () => {
    await loadCloudOrgMembers(store, auth("user-1"), "org-1");
    await loadCloudOrgMembers(store, auth("user-2"), "org-1");
    expect(listOrgMembersMock).toHaveBeenCalledTimes(2);
  });

  it("does not share in-flight or cached state across Jotai stores", async () => {
    const otherStore = createStore();
    const current = auth();
    await loadCloudOrgMembers(store, current, "org-1");
    await loadCloudOrgMembers(otherStore, current, "org-1");
    expect(listOrgMembersMock).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recent roster after the cache bound", async () => {
    const current = auth();
    for (let index = 0; index <= MAX_ROSTER_CACHE_ENTRIES; index += 1) {
      await loadCloudOrgMembers(store, current, `org-${index}`);
    }
    await loadCloudOrgMembers(store, current, "org-0");
    expect(listOrgMembersMock).toHaveBeenCalledTimes(
      MAX_ROSTER_CACHE_ENTRIES + 2
    );
  });
});
