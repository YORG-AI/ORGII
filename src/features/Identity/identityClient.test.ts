import { beforeEach, describe, expect, it, vi } from "vitest";

import { identityClient } from "./identityClient";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => tauri);

const SNAPSHOT = {
  revision: 7,
  sessions: [],
  activeSessions: {},
  flows: [],
  secureStoreStatus: "available",
};

describe("identityClient Tauri wire adapter", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.isTauri.mockReturnValue(true);
  });

  it("hydrates through the restore command", async () => {
    tauri.invoke.mockResolvedValue(SNAPSHOT);
    await expect(identityClient.retryRestore()).resolves.toEqual(SNAPSHOT);
    expect(tauri.invoke).toHaveBeenCalledWith(
      "identity_retry_restore",
      undefined
    );
  });

  it("starts Cloud OAuth with public endpoint coordinates only", async () => {
    const flowId = "77d6f0fe-128e-441b-bd71-0ed245fd4b10";
    tauri.invoke.mockResolvedValue({ flowId, snapshot: SNAPSHOT });

    await expect(
      identityClient.beginOrg2CloudSignIn({
        webOrigin: "https://cloud.example.test",
        supabaseUrl: "https://project.supabase.co",
        publicClientKey: "publishable-key",
      })
    ).resolves.toEqual({ flowId, snapshot: SNAPSHOT });
    expect(tauri.invoke).toHaveBeenCalledWith(
      "identity_begin_org2_cloud_sign_in",
      {
        input: {
          webOrigin: "https://cloud.example.test",
          supabaseUrl: "https://project.supabase.co",
          publicClientKey: "publishable-key",
        },
      }
    );
  });

  it("starts Hosted PKCE without exposing a verifier", async () => {
    const flowId = "77d6f0fe-128e-441b-bd71-0ed245fd4b10";
    tauri.invoke.mockResolvedValue({ flowId, snapshot: SNAPSHOT });

    await identityClient.beginHostedServiceSignIn({
      supabaseUrl: "https://project.supabase.co",
      publicClientKey: "publishable-key",
      redirectUri: "yorgai://marketplace/callback",
      provider: "github",
      scopes: "read:user user:email",
    });
    expect(tauri.invoke).toHaveBeenCalledWith(
      "identity_begin_hosted_service_sign_in",
      {
        input: {
          supabaseUrl: "https://project.supabase.co",
          publicClientKey: "publishable-key",
          redirectUri: "yorgai://marketplace/callback",
          provider: "github",
          scopes: "read:user user:email",
        },
      }
    );
    expect(JSON.stringify(tauri.invoke.mock.calls)).not.toContain("verifier");
  });

  it("requests an audience-bound Hosted access lease", async () => {
    tauri.invoke.mockResolvedValue({
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      generation: 3,
      issuer: "https://project.supabase.co",
      publicClientKey: "publishable-key",
      subject: "hosted-user",
      expiresAtUnix: 2_000_000_000,
      audience: "hosted_service_api",
      accessToken: "short-lived-access",
    });
    await identityClient.getHostedServiceAccessLease({
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      generation: 3,
    });
    expect(tauri.invoke).toHaveBeenCalledWith(
      "identity_get_hosted_service_access_lease",
      {
        input: {
          sessionId: "550e8400-e29b-41d4-a716-446655440000",
          generation: 3,
          audience: "hosted_service_api",
        },
      }
    );
  });

  it("sends an explicit realm and optional session on sign-out", async () => {
    tauri.invoke.mockResolvedValue(SNAPSHOT);
    await identityClient.signOut(
      "org2_cloud",
      "550e8400-e29b-41d4-a716-446655440000"
    );
    expect(tauri.invoke).toHaveBeenCalledWith("identity_sign_out", {
      input: {
        realm: "org2_cloud",
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
      },
    });
  });
});
