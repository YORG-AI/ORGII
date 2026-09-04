// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMobileAuthClient } from "./mobileAuthClient";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  setSession: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

describe("mobileAuthClient", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.createClient.mockReturnValue({ auth: mocks });
  });

  it("persists the PKCE verifier and uses the desktop GitHub scopes", async () => {
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: "https://github.example/oauth" },
      error: null,
    });
    const client = createMobileAuthClient();
    await expect(
      client.buildLoginUrl("https://mobile.example/orgii/mobile/auth/callback")
    ).resolves.toBe("https://github.example/oauth");
    expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: "github",
      options: {
        redirectTo: "https://mobile.example/orgii/mobile/auth/callback",
        skipBrowserRedirect: true,
        scopes: "read:user user:email",
      },
    });
    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://fpdyejwbiriliuqqcjoy.supabase.co",
      "sb_publishable_FpHAgMYJFGb20HunqnhciA_-2nt9eYU",
      {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: true,
          flowType: "pkce",
          storage: sessionStorage,
        },
      }
    );
  });

  it("accepts only a PKCE code and never exchanges tokens from the URL fragment", async () => {
    const client = createMobileAuthClient();
    await expect(
      client.exchangeCallback(
        "https://mobile.example/orgii/mobile/auth/callback#access_token=secret&refresh_token=secret"
      )
    ).rejects.toThrow("callback is incomplete");
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(mocks.setSession).not.toHaveBeenCalled();
  });
});
