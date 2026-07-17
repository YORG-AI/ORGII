import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import {
  CLOUD_SHARE_LEVEL,
  Org2CloudShareError,
  createCloudSessionShare,
  generateCloudShareToken,
  isCloudShareActive,
  isOrg2ShareErrorCode,
  listCloudSessionShares,
  resolveCloudSessionShare,
  revokeCloudSessionShare,
} from "./org2CloudSharesClient";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(lastCall().init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(jsonResponse(null));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("createCloudSessionShare", () => {
  it("link share: mints a token and sends ONLY its sha256", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ shareId: "share-1" }));
    const result = await createCloudSessionShare("jwt-1", {
      orgId: "org-1",
      sessionId: "sess-1",
      level: CLOUD_SHARE_LEVEL.REPLAY,
    });
    expect(result.shareId).toBe("share-1");
    // 32 bytes hex — the plaintext exists only in the result.
    expect(result.shareToken).toMatch(/^[0-9a-f]{64}$/);
    const body = lastBody();
    expect(body.p_org_id).toBe("org-1");
    expect(body.p_session_id).toBe("sess-1");
    expect(body.p_level).toBe("replay");
    expect(body.p_grantee_user_id).toBeNull();
    // The hash goes on the wire; the token itself never does.
    expect(body.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.p_token_hash).not.toBe(result.shareToken);
    expect(String(lastCall().init.body)).not.toContain(result.shareToken);
  });

  it("directed share: sends the grantee and NO token hash", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ shareId: "share-2" }));
    const result = await createCloudSessionShare("jwt-1", {
      orgId: "org-1",
      sessionId: "sess-1",
      level: CLOUD_SHARE_LEVEL.REPLAY,
      granteeUserId: "user-b",
    });
    expect(result.shareToken).toBeUndefined();
    const body = lastBody();
    expect(body.p_grantee_user_id).toBe("user-b");
    expect(body.p_token_hash).toBeNull();
  });

  it("sends JWT bearer + Content-Profile", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ shareId: "share-3" }));
    await createCloudSessionShare("jwt-9", {
      orgId: "org-1",
      sessionId: "sess-1",
      level: CLOUD_SHARE_LEVEL.METADATA,
      granteeUserId: "user-b",
    });
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_create_session_share`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-9");
    expect(headers["content-profile"]).toBe(ORG2_CLOUD_POSTGREST_SCHEMA);
  });
});

describe("listCloudSessionShares", () => {
  it("parses records and normalizes nullish fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        shares: [
          {
            id: "share-1",
            granteeUserId: null,
            level: "replay",
            expiresAt: null,
            createdAt: "2026-07-06T00:00:00.000Z",
            revokedAt: null,
            hasToken: true,
          },
          {
            id: "share-2",
            granteeUserId: "user-b",
            level: "replay",
            createdAt: "2026-07-05T00:00:00.000Z",
            revokedAt: "2026-07-06T00:00:00.000Z",
            hasToken: false,
          },
        ],
      })
    );
    const shares = await listCloudSessionShares("jwt-1", "org-1", "sess-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_session_id: "sess-1" });
    expect(shares).toHaveLength(2);
    expect(shares[0].granteeUserId).toBeUndefined();
    expect(shares[0].hasToken).toBe(true);
    expect(shares[1].revokedAt).toBe("2026-07-06T00:00:00.000Z");
  });
});

describe("revokeCloudSessionShare", () => {
  it("posts the share id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await revokeCloudSessionShare("jwt-1", "org-1", "share-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_share_id: "share-1" });
  });
});

describe("resolveCloudSessionShare (ticket tier)", () => {
  it("uses the anon key as bearer — no JWT exists for guests", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "org-1:user-a:sess-1",
        orgId: "org-1",
        ownerMemberId: "user-a",
        ownerUserId: "user-a",
        ownerDisplayName: "Alice",
        ownerIdentityKind: "human",
        sourceSessionId: "sess-1",
        title: "Shared session",
        eventsEpoch: 1,
        eventsCount: 3,
      })
    );
    const session = await resolveCloudSessionShare("t".repeat(64));
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_resolve_session_share`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Bearer ${ORG2_CLOUD_OFFICIAL_ANON_KEY}`
    );
    expect(lastBody()).toEqual({ p_share_token: "t".repeat(64) });
    expect(session.orgId).toBe("org-1");
    expect(session.sourceSessionId).toBe("sess-1");
    expect(session.eventsEpoch).toBe(1);
  });

  it("surfaces the opaque code on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_UNAUTHORIZED" }, 400)
    );
    const error = await resolveCloudSessionShare("x".repeat(64)).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Org2CloudShareError);
    expect(isOrg2ShareErrorCode(error, "ORG2_UNAUTHORIZED")).toBe(true);
  });
});

describe("Org2CloudShareError code extraction", () => {
  it("matches whole tokens only", () => {
    expect(new Org2CloudShareError("ORG2_FORBIDDEN").code).toBe(
      "ORG2_FORBIDDEN"
    );
    // A longer unknown code must not be mis-mapped to a listed prefix.
    expect(new Org2CloudShareError("ORG2_NOT_FOUND_DETAIL").code).toBeNull();
    expect(new Org2CloudShareError("plain failure").code).toBeNull();
  });
});

describe("isCloudShareActive", () => {
  const now = Date.parse("2026-07-06T12:00:00.000Z");
  const base: { expiresAt?: string; revokedAt?: string } = {};

  it("active when neither revoked nor expired", () => {
    expect(isCloudShareActive({ ...base }, now)).toBe(true);
  });

  it("revoked wins regardless of expiry", () => {
    expect(
      isCloudShareActive(
        { ...base, revokedAt: "2026-07-02T00:00:00.000Z" },
        now
      )
    ).toBe(false);
  });

  it("past expiry deactivates; future expiry does not", () => {
    expect(
      isCloudShareActive(
        { ...base, expiresAt: "2026-07-06T11:59:59.000Z" },
        now
      )
    ).toBe(false);
    expect(
      isCloudShareActive(
        { ...base, expiresAt: "2026-07-06T12:00:01.000Z" },
        now
      )
    ).toBe(true);
  });

  it("malformed expiry is treated as no expiry (server enforces anyway)", () => {
    expect(isCloudShareActive({ ...base, expiresAt: "not-a-date" }, now)).toBe(
      true
    );
  });
});

describe("generateCloudShareToken", () => {
  it("mints 32-byte hex tokens", () => {
    const token = generateCloudShareToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateCloudShareToken()).not.toBe(token);
  });
});
