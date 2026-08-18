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
  schemaVersion,
} from "./org2CloudClient";

const fetchMock = vi.fn();
const identityMocks = vi.hoisted(() => ({
  getAccessLease: vi.fn(),
  deleteLegacyEnvelope: vi.fn(),
}));

vi.mock("@src/features/Identity/identityClient", () => ({
  identityClient: {
    getOrg2CloudAccessLease: identityMocks.getAccessLease,
  },
  getIdentityErrorCode: (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error
      ? ((error as { code?: string }).code ?? null)
      : null,
}));

vi.mock("@src/api/http/auth/sharedAuthStorage", () => ({
  deleteLegacyOrg2CloudAuthEnvelope: identityMocks.deleteLegacyEnvelope,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  identityMocks.deleteLegacyEnvelope.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("ensureFreshSession", () => {
  const baseState: Org2CloudAuthState = {
    kind: "org2_cloud",
    sessionId: "00000000-0000-4000-8000-000000000001",
    generation: 4,
    supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
    userId: "user-1",
  };

  it("maps the native allow-listed lease into a transient request context", async () => {
    identityMocks.getAccessLease.mockResolvedValueOnce({
      sessionId: baseState.sessionId,
      generation: baseState.generation,
      issuer: baseState.supabaseUrl,
      publicClientKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
      subject: baseState.userId,
      expiresAtUnix: 1_751_503_600,
      audience: "org2_cloud_api",
      accessToken: "at-2",
    });
    await expect(ensureFreshSession(baseState)).resolves.toEqual({
      ...baseState,
      supabaseAnonKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
      accessToken: "at-2",
      expiresAt: 1_751_503_600,
    });
    expect(identityMocks.getAccessLease).toHaveBeenCalledWith({
      sessionId: baseState.sessionId,
      generation: baseState.generation,
    });
    expect(identityMocks.deleteLegacyEnvelope).toHaveBeenCalledTimes(1);
  });

  it("rejects a lease for a different Broker generation", async () => {
    identityMocks.getAccessLease.mockResolvedValueOnce({
      sessionId: baseState.sessionId,
      generation: baseState.generation + 1,
      issuer: baseState.supabaseUrl,
      publicClientKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
      subject: baseState.userId,
      expiresAtUnix: 1_751_503_600,
      audience: "org2_cloud_api",
      accessToken: "at-other",
    });
    await expect(ensureFreshSession(baseState)).resolves.toBeNull();
  });

  it("reports only a Broker credential rejection as permanent", async () => {
    const rejected = vi.fn();
    identityMocks.getAccessLease.mockRejectedValueOnce({
      code: "identity_access_refresh_rejected",
    });
    await expect(
      ensureFreshSession(baseState, { onRefreshRejected: rejected })
    ).resolves.toBeNull();
    expect(rejected).toHaveBeenCalledTimes(1);

    rejected.mockClear();
    identityMocks.getAccessLease.mockRejectedValueOnce({
      code: "identity_access_refresh_unavailable",
    });
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
