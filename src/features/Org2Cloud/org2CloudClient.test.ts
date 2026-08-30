import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
} from "./config";
import {
  ORG2_CLOUD_AUTH_STORAGE_KEY,
  type Org2CloudAuthState,
} from "./org2CloudAuthAtom";
import {
  adoptPersistedSessionRotation,
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

describe("adoptPersistedSessionRotation (cross-window refresh short-circuit)", () => {
  const nowSeconds = 1_751_500_000;
  const state: Org2CloudAuthState = {
    kind: "org2_cloud",
    supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
    supabaseAnonKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
    userId: "user-1",
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: nowSeconds, // already inside the refresh skew
  };
  const rotated: Org2CloudAuthState = {
    ...state,
    accessToken: "at-2",
    refreshToken: "rt-2",
    expiresAt: nowSeconds + 3600,
  };

  it("adopts a fresher persisted rotation for the same identity", () => {
    expect(adoptPersistedSessionRotation(state, rotated, nowSeconds)).toEqual({
      ...state,
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: nowSeconds + 3600,
    });
  });

  it("keeps the caller's non-token fields when adopting", () => {
    const withProfile: Org2CloudAuthState = {
      ...state,
      profile: { displayName: "Vince" },
    };
    expect(
      adoptPersistedSessionRotation(withProfile, rotated, nowSeconds)?.profile
    ).toEqual({ displayName: "Vince" });
  });

  it("never adopts across identities (other user or endpoint)", () => {
    expect(
      adoptPersistedSessionRotation(
        state,
        { ...rotated, userId: "user-2" },
        nowSeconds
      )
    ).toBeNull();
    expect(
      adoptPersistedSessionRotation(
        state,
        { ...rotated, supabaseUrl: "https://other.example.test" },
        nowSeconds
      )
    ).toBeNull();
  });

  it("normalizes trailing-slash endpoint differences via the identity key", () => {
    expect(
      adoptPersistedSessionRotation(
        state,
        { ...rotated, supabaseUrl: `${state.supabaseUrl}/` },
        nowSeconds
      )
    ).not.toBeNull();
  });

  it("ignores an absent or not-comfortably-fresh persisted copy", () => {
    expect(adoptPersistedSessionRotation(state, null, nowSeconds)).toBeNull();
    // Within the refresh skew: the exchange must still run.
    expect(
      adoptPersistedSessionRotation(
        state,
        { ...rotated, expiresAt: nowSeconds + 30 },
        nowSeconds
      )
    ).toBeNull();
  });
});

describe("ensureFreshSession cross-window refresh lock", () => {
  const stale: Org2CloudAuthState = {
    kind: "org2_cloud",
    supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
    supabaseAnonKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
    userId: "user-1",
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: 0,
  };

  afterEach(() => {
    localStorage.removeItem(ORG2_CLOUD_AUTH_STORAGE_KEY);
  });

  /** Grants immediately, records the requested lock names. */
  function stubWebLocks(): string[] {
    const requestedNames: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: (
          name: string,
          _options: unknown,
          callback: () => Promise<unknown>
        ) => {
          requestedNames.push(name);
          return callback();
        },
      },
    });
    return requestedNames;
  }

  it("re-reads the persisted rotation under the lock and skips the exchange", async () => {
    const requestedNames = stubWebLocks();
    const rotated: Org2CloudAuthState = {
      ...stale,
      accessToken: "at-rotated",
      refreshToken: "rt-rotated",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    localStorage.setItem(ORG2_CLOUD_AUTH_STORAGE_KEY, JSON.stringify(rotated));

    await expect(ensureFreshSession(stale)).resolves.toEqual(rotated);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestedNames).toEqual(["orgii:org2cloud-token-refresh"]);
  });

  it("still runs the exchange under the lock when the persisted copy is stale", async () => {
    const requestedNames = stubWebLocks();
    localStorage.setItem(ORG2_CLOUD_AUTH_STORAGE_KEY, JSON.stringify(stale));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_at: 1751503600,
      })
    );

    await expect(ensureFreshSession(stale)).resolves.toEqual({
      ...stale,
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: 1751503600,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedNames).toEqual(["orgii:org2cloud-token-refresh"]);
  });

  it("never adopts a persisted session belonging to another identity", async () => {
    stubWebLocks();
    localStorage.setItem(
      ORG2_CLOUD_AUTH_STORAGE_KEY,
      JSON.stringify({
        ...stale,
        userId: "user-2",
        accessToken: "at-other",
        refreshToken: "rt-other",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_at: 1751503600,
      })
    );

    const result = await ensureFreshSession(stale);
    expect(result?.accessToken).toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe("listMyOrgs homeEndpoint (0007)", () => {
  it("carries a roster row's homeEndpoint through", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          orgId: "org-1",
          name: "Acme",
          role: "member",
          homeEndpoint: "https://shard-2.supabase.co",
        },
      ])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      {
        orgId: "org-1",
        name: "Acme",
        role: "member",
        homeEndpoint: "https://shard-2.supabase.co",
      },
    ]);
  });

  it("omits homeEndpoint for pre-0007 rows without the key and for null", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { orgId: "org-1", name: "Acme", role: "owner" },
        { orgId: "org-2", name: "Beta", role: "member", homeEndpoint: null },
      ])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      { orgId: "org-1", name: "Acme", role: "owner" },
      { orgId: "org-2", name: "Beta", role: "member" },
    ]);
  });

  it("keeps the org and drops only the homeEndpoint when the value is malformed", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { orgId: "org-1", name: "Acme", role: "owner", homeEndpoint: 42 },
      ])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      { orgId: "org-1", name: "Acme", role: "owner" },
    ]);
  });
});

describe("listMyOrgs runtimeTelemetry (0010 member runtime)", () => {
  it("carries a roster row's runtimeTelemetry record through", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          orgId: "org-1",
          name: "Acme",
          role: "member",
          runtimeTelemetry: { enabled: true, intervalMinutes: 30 },
        },
      ])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      {
        orgId: "org-1",
        name: "Acme",
        role: "member",
        runtimeTelemetry: { enabled: true, intervalMinutes: 30 },
      },
    ]);
  });

  it("omits the record for pre-0010 rows and for null (feature off)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { orgId: "org-1", name: "Acme", role: "owner" },
        {
          orgId: "org-2",
          name: "Beta",
          role: "member",
          runtimeTelemetry: null,
        },
      ])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      { orgId: "org-1", name: "Acme", role: "owner" },
      { orgId: "org-2", name: "Beta", role: "member" },
    ]);
  });

  it("keeps the org and drops only a malformed record (degrades to off)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          orgId: "org-1",
          name: "Acme",
          role: "owner",
          runtimeTelemetry: { enabled: "yes", intervalMinutes: "soon" },
        },
      ])
    );
    await expect(listMyOrgs("at-1")).resolves.toEqual([
      { orgId: "org-1", name: "Acme", role: "owner" },
    ]);
  });
});
