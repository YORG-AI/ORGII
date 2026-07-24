import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
} from "./config";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import {
  ensureFreshSession,
  getCloudProfile,
  listMyOrgs,
  listOrgMembers,
  refreshSession,
  schemaVersion,
} from "./org2CloudClient";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("refreshSession", () => {
  it("exchanges the refresh token via the GoTrue endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_at: 1751503600,
        token_type: "bearer",
      })
    );

    const result = await refreshSession("rt-1");
    expect(result).toEqual({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: 1751503600,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    // Plain GoTrue call — no PostgREST schema profile header.
    expect(headers["content-profile"]).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: "rt-1" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null on non-200", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "invalid_grant" }, 400)
    );
    expect(await refreshSession("rt-bad")).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await refreshSession("rt-1")).toBeNull();
  });

  it("coalesces concurrent exchanges for the same endpoint and refresh token", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );

    const first = refreshSession("rt-shared");
    const second = refreshSession("rt-shared");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveResponse?.(
      jsonResponse({
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_at: 1751503600,
      })
    );
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        accessToken: "at-2",
        refreshToken: "rt-2",
        expiresAt: 1751503600,
      },
      {
        accessToken: "at-2",
        refreshToken: "rt-2",
        expiresAt: 1751503600,
      },
    ]);
  });
});

describe("ensureFreshSession", () => {
  const baseState: Org2CloudAuthState = {
    kind: "org2_cloud",
    supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
    supabaseAnonKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
    userId: "user-1",
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: 0,
  };

  it("returns the state untouched while the token is fresh", async () => {
    const state = {
      ...baseState,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    expect(await ensureFreshSession(state)).toBe(state);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes when the token expires within the skew window", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_at: 1751503600,
      })
    );
    const state = { ...baseState, expiresAt: Math.floor(Date.now() / 1000) };
    expect(await ensureFreshSession(state)).toEqual({
      ...state,
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: 1751503600,
    });
  });

  it("refreshes against the endpoint captured by the session", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at-custom-2",
        refresh_token: "rt-custom-2",
        expires_at: 1751503600,
      })
    );
    const state: Org2CloudAuthState = {
      ...baseState,
      supabaseUrl: "https://custom.example.test",
      supabaseAnonKey: "custom-anon-key",
    };

    await ensureFreshSession(state);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://custom.example.test/auth/v1/token?grant_type=refresh_token"
    );
    expect((init.headers as Record<string, string>).apikey).toBe(
      "custom-anon-key"
    );
  });

  it("returns null when the refresh fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    expect(await ensureFreshSession(baseState)).toBeNull();
  });

  it("reports only a credential rejection as a permanent auth failure", async () => {
    const rejected = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 400));
    await expect(
      ensureFreshSession(baseState, { onRefreshRejected: rejected })
    ).resolves.toBeNull();
    expect(rejected).toHaveBeenCalledTimes(1);

    rejected.mockClear();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(
      ensureFreshSession(baseState, { onRefreshRejected: rejected })
    ).resolves.toBeNull();
    expect(rejected).not.toHaveBeenCalled();
  });
});

describe("org2_cloud RPC calls", () => {
  it("schemaVersion carries apikey + Content-Profile headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(1));
    expect(await schemaVersion()).toBe(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/schema_version`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers["content-profile"]).toBe("org2_cloud");
    expect(headers.authorization).toBe(
      `Bearer ${ORG2_CLOUD_OFFICIAL_ANON_KEY}`
    );
  });

  it("getCloudProfile sends the user bearer token and maps the payload", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        userId: "user-1",
        displayName: "Vince",
        avatarUrl: null,
        primaryEmail: "v@example.com",
        createdAt: "2026-07-01T00:00:00Z",
      })
    );
    expect(await getCloudProfile("at-1")).toEqual({
      userId: "user-1",
      displayName: "Vince",
      avatarUrl: undefined,
      primaryEmail: "v@example.com",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer at-1"
    );
  });

  it("getCloudProfile returns null for the empty-object no-profile case", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    expect(await getCloudProfile("at-1")).toBeNull();
  });

  it("getCloudProfile returns null on non-200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "nope" }, 401));
    expect(await getCloudProfile("at-1")).toBeNull();
  });

  it("rejects the removed viewer role from org and member roster payloads", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ orgId: "org-1", name: "Acme", role: "viewer" }])
    );
    await expect(listMyOrgs("at-1")).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          userId: "user-2",
          displayName: "Viewer",
          role: "viewer",
          status: "active",
          joinedAt: "2026-07-01T00:00:00Z",
        },
      ])
    );
    await expect(listOrgMembers("at-1", "org-1")).resolves.toEqual([]);
  });
});

describe("listMyOrgs batched entitlements (0004)", () => {
  it("normalizes a roster row's entitlement payload", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          orgId: "org-1",
          name: "Acme",
          role: "member",
          entitlement: {
            plan: "pro",
            status: "active",
            replayRetentionDays: null,
            maxOrgMembers: 3,
            sessionSyncEnabled: true,
            orgSharingFloor: "metadata_only",
          },
        },
      ])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      {
        orgId: "org-1",
        name: "Acme",
        role: "member",
        entitlement: {
          plan: "pro",
          status: "active",
          maxOrgMembers: 3,
          sessionSyncEnabled: true,
          orgSharingFloor: "metadata_only",
        },
      },
    ]);
  });

  it("keeps the org and drops only the entitlement when the payload is malformed", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          orgId: "org-1",
          name: "Acme",
          role: "owner",
          entitlement: { plan: 42 },
        },
        { orgId: "org-2", name: "Beta", role: "member", entitlement: null },
      ])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      { orgId: "org-1", name: "Acme", role: "owner" },
      { orgId: "org-2", name: "Beta", role: "member" },
    ]);
  });

  it("parses pre-0004 rows without the entitlement key", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ orgId: "org-1", name: "Acme", role: "owner" }])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      { orgId: "org-1", name: "Acme", role: "owner" },
    ]);
  });
});
