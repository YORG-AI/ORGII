import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_POSTGREST_SCHEMA,
} from "./config";
import {
  Org2CloudManagementError,
  acceptCloudInvite,
  createCloudInvite,
  createCloudOrg,
  deleteCloudOrg,
  isOrg2ManagementErrorCode,
  leaveCloudOrg,
  listCloudInvites,
  removeCloudMember,
  renameCloudOrg,
  revokeCloudInvite,
  transferCloudOwnership,
  updateCloudMemberRole,
} from "./org2CloudManagementClient";
import { sha256Hex } from "./org2CloudOrgManagement";

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
  fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("headers + endpoints", () => {
  it("sends JWT bearer + Content-Profile on every management RPC", async () => {
    await leaveCloudOrg("jwt-1", "org-1");
    const { url, init } = lastCall();
    expect(url).toBe(
      `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/rest/v1/rpc/cloud_leave_org`
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(ORG2_CLOUD_OFFICIAL_ANON_KEY);
    expect(headers.authorization).toBe("Bearer jwt-1");
    expect(headers["content-profile"]).toBe(ORG2_CLOUD_POSTGREST_SCHEMA);
    expect(lastBody()).toEqual({ p_org_id: "org-1" });
  });
});

describe("org lifecycle", () => {
  it("create_org returns the new orgId", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ orgId: "org-9", name: "Acme" })
    );
    await expect(createCloudOrg("jwt-1", "Acme")).resolves.toEqual({
      orgId: "org-9",
    });
    expect(lastBody()).toEqual({ org_name: "Acme" });
  });

  it("cloud_rename_org returns the server-trimmed name", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, name: "Trimmed" })
    );
    await expect(renameCloudOrg("jwt-1", "org-1", "  Trimmed ")).resolves.toBe(
      "Trimmed"
    );
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_name: "  Trimmed " });
  });

  it("cloud_transfer_ownership posts the new owner", async () => {
    await transferCloudOwnership("jwt-1", "org-1", "user-2");
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_new_owner_user_id: "user-2",
    });
  });

  it("cloud_delete_org posts the org id", async () => {
    await deleteCloudOrg("jwt-1", "org-1");
    expect(lastCall().url).toContain("/rpc/cloud_delete_org");
    expect(lastBody()).toEqual({ p_org_id: "org-1" });
  });
});

describe("invites", () => {
  it("create_invite ships ONLY the sha256 of a locally minted code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ inviteId: "inv-1" }));
    const created = await createCloudInvite("jwt-1", {
      orgId: "org-1",
      role: "member",
      maxUses: 5,
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    const body = lastBody();
    expect(body.p_org_id).toBe("org-1");
    expect(body.invite_role).toBe("member");
    expect(body.max_uses).toBe(5);
    expect(body.expires_at).toBe("2026-08-01T00:00:00.000Z");
    // Plaintext must NOT be on the wire; the hash must match the plaintext
    // we got back for the one-time copy window.
    expect(String(body.invite_code_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain(created.inviteCode);
    await expect(sha256Hex(created.inviteCode)).resolves.toBe(
      body.invite_code_hash
    );
    expect(created.inviteId).toBe("inv-1");
    expect(created.inviteLink).toBe(
      `orgii://cloud/join?invite=${created.inviteCode}`
    );
  });

  it("create_invite omits expiry as null (never expires)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ inviteId: "inv-2" }));
    await createCloudInvite("jwt-1", {
      orgId: "org-1",
      role: "admin",
      maxUses: 1,
    });
    expect(lastBody().expires_at).toBeNull();
  });

  it("accept_invite hashes the pasted code and returns {orgId, role}", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ orgId: "org-1", role: "member" })
    );
    await expect(acceptCloudInvite("jwt-1", "plain-code")).resolves.toEqual({
      orgId: "org-1",
      role: "member",
    });
    expect(lastBody()).toEqual({
      invite_code_hash: await sha256Hex("plain-code"),
    });
  });

  it("rejects the removed viewer role from invite responses", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ orgId: "org-1", role: "viewer" })
    );
    await expect(acceptCloudInvite("jwt-1", "plain-code")).rejects.toThrow();
  });

  it("cloud_list_invites normalizes nullish expiry/revocation", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        invites: [
          {
            inviteId: "inv-1",
            role: "member",
            maxUses: 10,
            usedCount: 3,
            expiresAt: null,
            createdAt: "2026-07-01T00:00:00Z",
            revokedAt: null,
          },
          {
            inviteId: "inv-2",
            role: "admin",
            maxUses: 1,
            usedCount: 0,
            expiresAt: "2026-07-08T00:00:00Z",
            createdAt: "2026-06-30T00:00:00Z",
            revokedAt: "2026-07-02T00:00:00Z",
          },
        ],
      })
    );
    const invites = await listCloudInvites("jwt-1", "org-1");
    expect(invites).toHaveLength(2);
    expect(invites[0].expiresAt).toBeUndefined();
    expect(invites[0].revokedAt).toBeUndefined();
    expect(invites[1].revokedAt).toBe("2026-07-02T00:00:00Z");
    expect(lastBody()).toEqual({ p_org_id: "org-1" });
  });

  it("cloud_revoke_invite posts org + invite ids", async () => {
    await revokeCloudInvite("jwt-1", "org-1", "inv-1");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_invite_id: "inv-1" });
  });
});

describe("members", () => {
  it("cloud_update_member_role posts the target + role", async () => {
    await updateCloudMemberRole("jwt-1", "org-1", "user-2", "admin");
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_user_id: "user-2",
      p_role: "admin",
    });
  });

  it("cloud_remove_member posts the target", async () => {
    await removeCloudMember("jwt-1", "org-1", "user-2");
    expect(lastBody()).toEqual({ p_org_id: "org-1", p_user_id: "user-2" });
  });
});

describe("error surface", () => {
  it("maps §22 codes into Org2CloudManagementError.code", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_LAST_ADMIN" }, 409)
    );
    const error = await updateCloudMemberRole(
      "jwt-1",
      "org-1",
      "user-2",
      "member"
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Org2CloudManagementError);
    expect(isOrg2ManagementErrorCode(error, "ORG2_LAST_ADMIN")).toBe(true);
    expect((error as Org2CloudManagementError).status).toBe(409);
  });

  it("keeps invite-lifecycle codes distinct", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "ORG2_INVITE_EXHAUSTED" }, 409)
    );
    const error = await acceptCloudInvite("jwt-1", "code").catch(
      (caught: unknown) => caught
    );
    expect(isOrg2ManagementErrorCode(error, "ORG2_INVITE_EXHAUSTED")).toBe(
      true
    );
    expect(isOrg2ManagementErrorCode(error, "ORG2_INVITE_INVALID")).toBe(false);
  });

  it("falls back to a status message when the body has no message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    const error = await leaveCloudOrg("jwt-1", "org-1").catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Org2CloudManagementError);
    expect((error as Org2CloudManagementError).message).toContain(
      "cloud_leave_org failed with 500"
    );
    expect((error as Org2CloudManagementError).code).toBeNull();
  });
});

describe("transport retry (WebKit stale keep-alive socket)", () => {
  it("recovers when the first POST dies with 'Load failed'", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(
      updateCloudMemberRole("jwt-1", "org-1", "user-2", "admin")
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastBody()).toEqual({
      p_org_id: "org-1",
      p_user_id: "user-2",
      p_role: "admin",
    });
  });

  it("propagates the raw TypeError when the retry also fails", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Load failed"));
    await expect(leaveCloudOrg("jwt-1", "org-1")).rejects.toThrow(
      "Load failed"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
